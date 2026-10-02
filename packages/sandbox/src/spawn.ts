/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * OS-level sandbox spawner — bridges Node.js child_process to OS-level isolation.
 *
 * This module provides the implementation for spawning processes under
 * OS-level sandboxes (seatbelt, landlock, Windows restricted token).
 *
 * Architecture mirrors codex-sandboxing/src/spawn.rs in Rust; concrete flag
 * and profile choices are checked against codex-rs/linux-sandbox and
 * codex-rs/sandboxing for parity. The handle this module returns tells the
 * truth about what was actually applied — an unenforced sandbox reports
 * `isSandboxed: false` rather than claiming isolation it does not have.
 */

import { ChildProcess, spawn } from "child_process"

import {
  DEFAULT_EXEC_COMMAND_TIMEOUT_MS,
  EXEC_OUTPUT_MAX_BYTES,
  IO_DRAIN_TIMEOUT_MS,
  MAX_EXEC_OUTPUT_DELTAS_PER_CALL,
} from "../../core/src/process.js"

import { SandboxType, NetworkSandboxPolicy, SpawnRequest, SpawnedProcess } from "./types.js"
import { spawnWindowsAcShim, taskkillTree } from "./windows-ac.js"

/**
 * Output/timeout limits live once, in core's process.ts — this module
 * re-exports the sandbox package's historical names so the public API keeps
 * them. They previously existed twice (spawn.ts and process.ts), two free-
 * standing "256KB" definitions that could silently drift apart.
 */
export {
  DEFAULT_EXEC_COMMAND_TIMEOUT_MS,
  EXEC_OUTPUT_MAX_BYTES as OUTPUT_MAX_BYTES,
  IO_DRAIN_TIMEOUT_MS,
  MAX_EXEC_OUTPUT_DELTAS_PER_CALL,
}

/**
 * Spawn a process with the appropriate sandbox type.
 *
 * Enforces the request's `timeoutMs` (a previously ignored field) and
 * escalates AbortSignal cancellation to a process-group kill, so hung
 * children and cancelled spawns cannot leave grandchildren behind.
 */
export async function spawnProcess(request: SpawnRequest): Promise<SpawnedProcess> {
  const { command, cwd, sandboxType, env, networkPolicy, timeoutMs, outputCap, signal } = request

  let proc: SpawnedProcess
  switch (sandboxType) {
    case SandboxType.MacosSeatbelt:
      proc = await spawnUnderSeatbelt(command, cwd, env, networkPolicy, outputCap, signal)
      break
    case SandboxType.LinuxSeccomp:
      proc = await spawnUnderLandlock(command, cwd, env, networkPolicy, outputCap, signal)
      break
    case SandboxType.WindowsRestrictedToken:
      proc = await spawnUnderWindowsAppContainer(request)
      break
    case SandboxType.None:
    default:
      proc = await spawnUnsandboxed(command, cwd, env, outputCap, signal)
  }

  if (timeoutMs > 0) armTimeout(proc, timeoutMs)
  armAbort(proc, signal)
  return proc
}

/**
 * Backstop for SpawnRequest.timeoutMs. The field was previously accepted
 * and dropped: a hung child was never reaped by the spawner itself. Callers
 * that track their own deadline simply win the race; this catches the rest.
 */
function armTimeout(proc: SpawnedProcess, timeoutMs: number): void {
  const timer = setTimeout(() => {
    void proc.kill("SIGKILL")
  }, timeoutMs)
  proc.waitForExit().then(
    () => clearTimeout(timer),
    () => clearTimeout(timer),
  )
}

/**
 * Escalate AbortSignal cancellation to a group kill. child_process's own
 * signal handling only SIGTERMs the direct child; detached POSIX children
 * lead their own groups, so without this grandchildren would outlive an
 * abort.
 */
function armAbort(proc: SpawnedProcess, signal: AbortSignal | undefined): void {
  if (!signal) return
  if (signal.aborted) {
    void proc.kill("SIGKILL")
    return
  }
  const onAbort = (): void => {
    void proc.kill("SIGKILL")
  }
  signal.addEventListener("abort", onAbort, { once: true })
  proc.waitForExit().then(
    () => signal.removeEventListener("abort", onAbort),
    () => signal.removeEventListener("abort", onAbort),
  )
}

/**
 * Shared child_process options. POSIX children are spawned detached so each
 * becomes its own process-group leader and `kill(-pid)` reaches grandchildren
 * (see getPgid); Windows has no process groups and keeps the default.
 */
function hostSpawnOptions(cwd: string, env: Record<string, string>, signal?: AbortSignal) {
  return {
    cwd,
    env,
    signal,
    windowsHide: true,
    detached: process.platform !== "win32",
  }
}

/**
 * Spawn under macOS seatbelt using sandbox-exec.
 *
 * The profile travels inline via `-p`, exactly as Codex invokes it
 * (codex-rs/sandboxing/src/seatbelt.rs passes `["-p", full_policy]`).
 */
async function spawnUnderSeatbelt(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  networkPolicy: NetworkSandboxPolicy,
  outputCap: number,
  signal?: AbortSignal,
): Promise<SpawnedProcess> {
  const sandboxExec = "/usr/bin/sandbox-exec"
  const args = ["-p", seatbeltProfile(networkPolicy), ...command]

  const child = spawn(sandboxExec, args, hostSpawnOptions(cwd, env, signal))
  const pgid = getPgid(child.pid ?? 0)

  return createSpawnedProcess(child, /*isSandboxed*/ true, SandboxType.MacosSeatbelt, pgid, outputCap)
}

/**
 * SBPL profile text for sandbox-exec. Later rules win in SBPL, so the
 * network deny follows `(allow default)`.
 *
 * The previous implementation wrote a JSON document to
 * ~/.trayambak/seatbelt.sbpl and handed it to `-f`: sandbox-exec expects
 * SBPL text, so every seatbelt spawn failed on a parse error — and the
 * fixed path raced concurrent spawns over each other's policies.
 */
export function seatbeltProfile(networkPolicy: NetworkSandboxPolicy): string {
  return networkPolicy?.disableNetwork
    ? "(version 1)\n(allow default)\n(deny network*)\n"
    : "(version 1)\n(allow default)\n"
}

/**
 * Spawn under Linux with bubblewrap (or fail honestly if it is missing).
 */
async function spawnUnderLandlock(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  networkPolicy: NetworkSandboxPolicy,
  outputCap: number,
  signal?: AbortSignal,
): Promise<SpawnedProcess> {
  const bwrap = "/usr/bin/bwrap"
  const args = landlockArgs(command, cwd, networkPolicy)

  const child = spawn(bwrap, args, hostSpawnOptions(cwd, env, signal))
  const pgid = getPgid(child.pid ?? 0)

  return createSpawnedProcess(child, /*isSandboxed*/ true, SandboxType.LinuxSeccomp, pgid, outputCap)
}

/**
 * bubblewrap argument list, split out so flag construction is testable on
 * hosts without bwrap (Codex parity: codex-rs/linux-sandbox/src/bwrap.rs).
 *
 * Replaces three broken shapes:
 * - `--unshare-all` dropped the network namespace unconditionally,
 *   ignoring a policy that allows network; the Codex flags unshare user
 *   and pid always and network only when the policy asks for it.
 * - `--net /dev/null` was never a bubblewrap option — every network-
 *   disabled spawn died with "unknown option" instead of sandboxing.
 * - `--ro-bind cwd cwd` was immediately re-mounted by the following
 *   `--bind cwd cwd`: a dead mount pair that cancelled itself out.
 */
export function landlockArgs(command: string[], cwd: string, networkPolicy: NetworkSandboxPolicy): string[] {
  return [
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    ...(networkPolicy?.disableNetwork ? ["--unshare-net"] : []),
    "--bind",
    cwd,
    cwd,
    "--chdir",
    cwd,
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    ...command,
  ]
}

/**
 * Windows AppContainer OS sandbox (windows-ac.ts has the verified recipe).
 *
 * Spawns the PowerShell shim, waits for the status handshake that proves an
 * AppContainer child is genuinely running, then reports `isSandboxed: true`
 * backed by kernel enforcement: default-deny NTFS ACLs, Low integrity, no
 * user SID, spawn-time network capability SIDs. The child inherits the
 * shim's pipe handles, so `readAll`/`waitForExit` stream bytes exactly like
 * every other backend. Kill escalates to `taskkill /T` so the sandboxed
 * command dies with its shim. Any infrastructure failure falls back to an
 * honest unsandboxed spawn (`isSandboxed: false`) instead of claiming
 * isolation that was not applied.
 */
async function spawnUnderWindowsAppContainer(request: SpawnRequest): Promise<SpawnedProcess> {
  const { command, cwd, env, networkPolicy, filesystemPolicy, outputCap, signal } = request
  try {
    const shim = await spawnWindowsAcShim({
      command,
      cwd,
      env,
      networkDisabled: networkPolicy.disableNetwork,
      writableRoots: filesystemPolicy.writableRoots,
      denyReadPaths: filesystemPolicy.denyReadPaths,
      denyWritePaths: filesystemPolicy.denyWritePaths,
      signal,
    })
    const handle = createSpawnedProcess(
      shim.child,
      /*isSandboxed*/ true,
      SandboxType.WindowsRestrictedToken,
      0,
      outputCap,
    )
    const killDirect = handle.kill
    handle.kill = async (sig: string = "SIGKILL") => {
      // taskkill /T reaches the AppContainer child through the shim; a bare
      // TerminateProcess on the shim would leave the command running.
      await taskkillTree(shim.pid)
      await killDirect(sig)
    }
    return handle
  } catch {
    // The handshake failed — no isolation exists, so report none.
    return spawnUnsandboxed(command, cwd, env, outputCap, signal)
  }
}

/**
 * Spawn without any sandbox (fallback).
 *
 * POSIX children are spawned detached: each becomes its own process-group
 * leader, so `kill(-pid)` really reaches grandchildren instead of missing
 * (ESRCH) the way it did when the child shared the agent's group.
 */
async function spawnUnsandboxed(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  outputCap: number,
  signal?: AbortSignal,
): Promise<SpawnedProcess> {
  const child = spawn(command[0], command.slice(1), hostSpawnOptions(cwd, env, signal))
  const pgid = getPgid(child.pid ?? 0)

  return createSpawnedProcess(child, /*isSandboxed*/ false, SandboxType.None, pgid, outputCap)
}

/**
 * Create a SpawnedProcess handle from a ChildProcess.
 */
function createSpawnedProcess(
  child: ChildProcess,
  isSandboxed: boolean,
  sandboxType: SandboxType,
  pgid: number,
  defaultMaxBytes: number,
): SpawnedProcess {
  return {
    pid: child.pid ?? 0,
    isSandboxed,
    sandboxType,
    processGroupId: pgid,

    async kill(signal: string = "SIGKILL") {
      const sig = signal as NodeJS.Signals
      if (process.platform !== "win32" && pgid > 0) {
        try {
          // Kill entire process group
          process.kill(-pgid, sig)
        } catch {
          /* process already dead */
        }
      }
      try {
        child.kill(sig)
      } catch {
        /* ignore */
      }
    },

    async readAll(options = {}) {
      // The request's outputCap is the default; explicit options override.
      const { maxBytes = defaultMaxBytes, maxDeltas = MAX_EXEC_OUTPUT_DELTAS_PER_CALL } = options
      return new Promise<string>((resolve, reject) => {
        // Streams already ended or destroyed (child closed before anyone
        // read): those bytes are unrecoverable — a late 'data' listener
        // never fires, so resolving now beats burning the whole IO drain
        // timeout on events that cannot happen.
        const drained = (stream: typeof child.stdout): boolean =>
          stream === null || stream.readableEnded || stream.destroyed
        if (drained(child.stdout) && drained(child.stderr)) {
          resolve("")
          return
        }

        let output = ""
        let byteCount = 0
        let deltaCount = 0
        let settled = false
        let exited = child.exitCode !== null || child.signalCode !== null
        let drainTimer: ReturnType<typeof setTimeout> | undefined

        const finish = (error?: Error): void => {
          if (settled) return
          settled = true
          if (drainTimer) clearTimeout(drainTimer)
          child.stdout?.off("data", onData)
          child.stdout?.off("end", checkSettle)
          child.stdout?.off("close", checkSettle)
          child.stderr?.off("data", onData)
          child.stderr?.off("end", checkSettle)
          child.stderr?.off("close", checkSettle)
          child.off("exit", onExit)
          child.off("close", onClose)
          child.off("error", onError)
          if (error) reject(error)
          else resolve(output)
        }

        function onData(chunk: Buffer): void {
          if (byteCount >= maxBytes) {
            output += `\n\n[output capped at ${maxBytes} bytes]`
            ;(child.stdout as unknown as { destroy?: () => void })?.destroy?.()
            ;(child.stderr as unknown as { destroy?: () => void })?.destroy?.()
            return
          }
          const chunkStr = chunk.toString("utf8")
          const remaining = maxBytes - byteCount
          output += chunkStr.slice(0, remaining)
          byteCount += chunk.length
          deltaCount++
          if (deltaCount >= maxDeltas) {
            ;(child.stdout as unknown as { destroy?: () => void })?.destroy?.()
            ;(child.stderr as unknown as { destroy?: () => void })?.destroy?.()
          }
        }

        function checkSettle(): void {
          // Streams finished after exit: everything is buffered into output.
          if (exited && drained(child.stdout) && drained(child.stderr)) finish()
        }

        function onClose(): void {
          finish()
        }

        function onExit(): void {
          exited = true
          if (drained(child.stdout) && drained(child.stderr)) {
            finish()
            return
          }
          // The child ended but a grandchild can hold the pipe open. Give
          // the streams a bounded window to flush, then settle with what we
          // have — partial output beats losing the run. (This timer used to
          // arm at readAll() call time, rejecting every command longer than
          // IO_DRAIN_TIMEOUT_MS.)
          if (drainTimer) return
          drainTimer = setTimeout(() => finish(), IO_DRAIN_TIMEOUT_MS)
        }

        function onError(error: Error): void {
          finish(error)
        }

        child.stdout?.on("data", onData)
        child.stdout?.on("end", checkSettle)
        child.stdout?.on("close", checkSettle)
        child.stderr?.on("data", onData)
        child.stderr?.on("end", checkSettle)
        child.stderr?.on("close", checkSettle)
        child.on("exit", onExit)
        child.on("close", onClose)
        child.on("error", onError)
        if (exited) onExit()
      })
    },

    async waitForExit() {
      // A child that already exited before this call would emit 'close'
      // into the void and hang the promise forever — check first.
      if (child.exitCode !== null || child.signalCode !== null) return child.exitCode ?? 1
      return new Promise<number>((resolve) => {
        child.on("close", (code) => resolve(code ?? 1))
        child.on("error", () => resolve(1))
      })
    },
  }
}

/**
 * Process-group id for tree-killing. Detached POSIX children lead their own
 * group, so the group id equals the child's pid by construction — Node
 * exposes no getpgid binding, and the previous code returned `pid` while
 * the child was still in the agent's group, making every `kill(-pid)` miss.
 * Windows has no process groups: report 0 and skip the group path.
 */
function getPgid(pid: number): number {
  if (process.platform === "win32" || pid === 0) return 0
  return pid
}

/**
 * Check if a process is running inside an OS-level sandbox.
 */
export function isProcessSandboxed(): boolean {
  return process.env.CODEX_SANDBOX !== undefined || process.env.CODEX_SANDBOX_NETWORK_DISABLED !== undefined
}
