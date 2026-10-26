/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Portions derived from OpenAI Codex CLI (codex-rs), Copyright 2025 OpenAI,
 * licensed under the Apache License, Version 2.0. See THIRD_PARTY_NOTICES.md.
 */

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
import { randomBytes } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import {
  DEFAULT_EXEC_COMMAND_TIMEOUT_MS,
  EXEC_OUTPUT_MAX_BYTES,
  IO_DRAIN_TIMEOUT_MS,
  MAX_EXEC_OUTPUT_DELTAS_PER_CALL,
} from "../../core/src/process.js"

import {
  SandboxType,
  NetworkSandboxPolicy,
  FileSystemSandboxPolicy,
  SpawnRequest,
  SpawnedProcess,
} from "./types.js"
import {
  isInside,
  linuxSandboxArgs,
  seatbeltPolicyText,
  writableRootsAfterCarveOut,
  LINUX_SYSTEM_ROOTS,
  MACOS_SYSTEM_ROOTS,
} from "./fs-policy.js"
import { acWorkloadIncompatible } from "./ac-workload.js"
import { applyProxyEnv, isLoopbackHost, parseProxyUrl, type ParsedProxy } from "./proxy-env.js"
import { proxyEndpoint } from "./proxy-routing.js"
import { buildFilter, encodeFilter, maskFlags, masksForHome } from "./seccomp.js"
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
      proc = await spawnUnderSeatbelt(command, cwd, env, request, outputCap, signal)
      break
    case SandboxType.LinuxSeccomp:
    case SandboxType.LinuxNamespace:
      // The two cases are the same code path, and the distinction is made INSIDE,
      // from whether the filter actually staged. Routing them together here is
      // what stops `LinuxNamespace` falling through to `default` and spawning
      // with NO isolation at all — a fail-open that would only be reachable by
      // asking for the weaker sandbox, which is the wrong direction to fail.
      proc = await spawnUnderLandlock(command, cwd, env, request, outputCap, signal)
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
 *
 * The whole `SpawnRequest` is taken rather than a `networkPolicy` argument
 * because the filesystem policy has to reach the profile. This signature used to
 * accept only the network policy, and `seatbeltProfile` consequently had no way
 * to know whether the session was allowed to write — it emitted `(allow
 * default)` and the process was told `isSandboxed: true`.
 */
async function spawnUnderSeatbelt(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  request: SpawnRequest,
  outputCap: number,
  signal?: AbortSignal,
): Promise<SpawnedProcess> {
  const sandboxExec = "/usr/bin/sandbox-exec"
  const profile = seatbeltProfile(request.networkPolicy, request.filesystemPolicy)
  const args = ["-p", profile, ...command]

  const child = spawn(sandboxExec, args, hostSpawnOptions(cwd, env, signal))
  const pgid = getPgid(child.pid ?? 0)

  return createSpawnedProcess(child, /*isSandboxed*/ true, SandboxType.MacosSeatbelt, pgid, outputCap)
}

/**
 * SBPL profile text for sandbox-exec.
 *
 * Deny-by-default, granting only what the filesystem policy allows. The previous
 * implementation wrote a JSON document to ~/.nemo/seatbelt.sbpl and handed
 * it to `-f`: sandbox-exec expects SBPL text, so every seatbelt spawn failed on
 * a parse error — and the fixed path raced concurrent spawns over each other's
 * policies.
 *
 * When it did parse, it emitted `(allow default)`, which permits every file
 * operation on the host: a `read-only` session could write anywhere. The profile
 * is now generated by `seatbeltPolicyText`, which orders the rules so that later
 * rules never re-grant what an earlier deny removed.
 */
export function seatbeltProfile(
  networkPolicy: NetworkSandboxPolicy | undefined,
  filesystemPolicy?: FileSystemSandboxPolicy,
): string {
  return seatbeltPolicyText(
    writableRootsAfterCarveOut(filesystemPolicy),
    MACOS_SYSTEM_ROOTS,
    networkPolicy?.disableNetwork === true,
    filesystemPolicy?.denyReadPaths ?? [],
  )
}

/**
 * Spawn under Linux with bubblewrap (or fail honestly if it is missing).
 */
async function spawnUnderLandlock(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  request: SpawnRequest,
  outputCap: number,
  signal?: AbortSignal,
): Promise<SpawnedProcess> {
  const bwrap = "/usr/bin/bwrap"
  const hardening = prepareLinuxHardening({
    // A filter is the point of the layer, so it is on unless the caller turned
    // it off. Deliberately not keyed off an env var here: the env gateway in
    // core is the only sanctioned way to read one, and a sandbox module reading
    // `process.env` directly is a rule this repo enforces with lint.
    seccomp: request.seccomp !== false,
    home: env.HOME ?? env.USERPROFILE,
  })

  const networkDisabled = request.networkPolicy?.disableNetwork === true

  // The host's proxy environment is the one egress control the route table does
  // not govern. `HTTPS_PROXY` pointing at a corporate egress proxy means the
  // SANDBOXED process connects there, that proxy resolves the name and opens the
  // socket, and `decideRoute` — which lives in this process and reads command
  // text — never sees the connection. One inherited variable bypasses the
  // allow-list completely.
  //
  // There is no bridge yet: that is a loopback listener inside the namespace plus
  // a Unix-socket descriptor handoff from the parent, which is Rust plumbing and
  // not something to fake in TypeScript. So the honest outcomes are the two this
  // function can reach on its own — strip the variables when there is no route
  // out, and otherwise say on the handle that policy is NOT enforced at the
  // socket. Claiming enforcement here would be the same defect as stamping
  // `LinuxSeccomp` before a filter existed.
  const proxy = applyProxyEnv(env, {
    bridge: bridgeEndpointFor(request),
    networkDisabled,
    policyConfigured: (request.networkPolicy?.allowedDomains?.length ?? 0) > 0,
  })

  let args: string[]
  let child: ChildProcess
  try {
    args = landlockArgs(command, cwd, request.networkPolicy, request.filesystemPolicy, hardening)
    child = spawn(bwrap, args, hostSpawnOptions(cwd, proxy.env, signal))
  } catch (error) {
    // The spawn never happened, so nothing holds the descriptor. This is the
    // path that leaks one per call if cleanup is not here.
    hardening.cleanup()
    throw error
  }
  // `spawn` has already duplicated the descriptor into the child, so the
  // parent's copy is dead the moment it returns. Holding it until the process
  // exits would leak a descriptor for the full lifetime of every command.
  hardening.cleanup()

  const pgid = getPgid(child.pid ?? 0)
  const applied = hardening.seccompApplied
  const handle = createSpawnedProcess(
    child,
    /*isSandboxed*/ true,
    applied ? SandboxType.LinuxSeccomp : SandboxType.LinuxNamespace,
    pgid,
    outputCap,
  )
  if (proxy.unenforced) {
    // Reported before the seccomp note: an unenforced allow-list is the larger
    // claim being wrong, and a handle carries one reason string, so the one that
    // matters most has to be the one that survives.
    handle.fallbackReason = proxy.detail
  } else if (!applied) {
    handle.fallbackReason =
      "seccomp filter could not be staged; namespaces only. Namespaces are a boundary, not a wall."
  } else if (!hardening.masksApplied) {
    handle.fallbackReason = "credential-store masks could not be built; filesystem policy still applies."
  }
  return handle
}

/**
 * The in-sandbox proxy bridge, when the request names one.
 *
 * Currently always undefined, and that is the honest default. A bridge needs a
 * loopback listener inside the namespace and a Unix-socket descriptor handoff
 * from the parent; neither exists. What CAN be decided without that plumbing is
 * whether the configured endpoint is usable at all — https with a CA bundle,
 * reachable as loopback — so that is what this checks, and it returns undefined
 * for every other case.
 *
 * The alternative, inventing a loopback port and pointing the sandbox at it,
 * produces a child that cannot reach anything AND a handle that claims a bridge
 * exists. Both halves of that are worse than saying nothing.
 */
function bridgeEndpointFor(request: SpawnRequest): ParsedProxy | undefined {
  const configured = request.networkPolicy?.proxy
  const endpoint = proxyEndpoint(configured, DEFAULT_BRIDGE_PORT)
  if (endpoint.problem !== undefined) return undefined
  const parsed = parseProxyUrl(endpoint.upstream ?? configured?.url ?? "")
  if (!parsed || !isLoopbackHost(parsed.host)) return undefined
  return { ...parsed, port: endpoint.port }
}

/** The loopback port the bridge would listen on. Fixed so the env is stable. */
const DEFAULT_BRIDGE_PORT = 3128

/**
 * Linux hardening handed to bubblewrap for one spawn.
 *
 * The descriptor and its cleanup travel together on purpose. Splitting them is
 * how a descriptor leaks: the caller builds the args, something throws before
 * the spawn, and nothing closes the fd. A sandbox that leaks a descriptor per
 * spawn exhausts the process's table long before memory, and the failure
 * surfaces as "too many open files" somewhere unrelated.
 */
export interface LinuxHardening {
  /** Open descriptor carrying the encoded seccomp filter, when one was staged. */
  seccompFd?: number
  /** Extra mount flags, e.g. the `--tmpfs` pairs that hide credential stores. */
  extraFlags?: string[]
  /** False when a seccomp filter was requested but could not be staged. */
  seccompApplied: boolean
  /** False when the mask list could not be built. */
  masksApplied: boolean
  /** Idempotent. Safe on every exit path, including a spawn that never ran. */
  cleanup: () => void
}

/**
 * Prepare Linux hardening for one spawn.
 *
 * Everything here is best-effort and REPORTS what it did, because the caller
 * cannot treat a failure as one thing:
 *
 *  - The filter could not be staged (no writable temp dir, descriptor table full,
 *    bwrap absent). That is an infrastructure failure. The spawn should still go
 *    ahead inside the namespace, one layer thinner — and must say so, because
 *    `SandboxType.LinuxSeccomp` names seccomp and a spawn that reports that type
 *    without a filter installed is the same declared-but-unenforced defect as the
 *    filesystem policy that was threaded but never read.
 *  - The filter is switched off deliberately by config. Same reporting duty.
 *
 * The rule this function exists to keep: never claim a layer that was not
 * applied. `seccompApplied` exists so the caller can propagate the truth.
 */
export function prepareLinuxHardening(
  options: {
    /** False to skip the seccomp filter entirely. */
    seccomp?: boolean
    /** Home directory the credential masks are rewritten against. */
    home?: string
    /** Where the filter is staged. Defaults to the OS temp dir. */
    tmpDir?: string
    /** Injectable for tests; defaults to a temp file plus `openSync`. */
    stage?: (bytes: Buffer, tmpDir: string) => { path: string; fd: number }
  } = {},
): LinuxHardening {
  const stagedPaths: string[] = []
  const stage = options.stage ?? stageSeccompFilter
  // Held in a closure variable rather than read back off `hardening`, because
  // cleanup has to clear the field to make itself idempotent — and reading it
  // back after clearing it would close `undefined`, throw EBADF, be swallowed by
  // the catch, and leak the descriptor. That is precisely the failure the
  // idempotence guard exists to prevent, caused by the guard itself.
  let seccompFd: number | undefined

  const hardening: LinuxHardening = {
    seccompApplied: false,
    masksApplied: false,
    cleanup: () => {
      // Idempotent: every exit path calls this, and a double close raises EBADF,
      // which would replace the real error with a confusing one.
      if (seccompFd === undefined) return
      const fd = seccompFd
      seccompFd = undefined
      hardening.seccompFd = undefined
      try {
        fs.closeSync(fd)
      } catch {
        /* already gone */
      }
    },
  }

  if (options.seccomp !== false) {
    try {
      const bytes = encodeFilter(buildFilter({ arch: currentArch() }))
      const staged = stage(bytes, options.tmpDir ?? os.tmpdir())
      stagedPaths.push(staged.path)
      seccompFd = staged.fd
      hardening.seccompFd = staged.fd
      hardening.seccompApplied = true
    } catch {
      // No filter. The namespace still applies; this layer does not.
    }
  }

  try {
    hardening.extraFlags = maskFlags(masksForHome(options.home ?? os.homedir()))
    hardening.masksApplied = true
  } catch {
    hardening.extraFlags = []
  }

  // The staged filter file is unlinked as soon as the descriptor exists: the
  // bytes are reachable through the fd, and an open fd keeps the inode alive, so
  // the name in the temp dir is both unnecessary and a second thing to leak.
  for (const p of stagedPaths) {
    try {
      fs.unlinkSync(p)
    } catch {
      /* already gone */
    }
  }

  return hardening
}

/**
 * Stage the encoded filter in a private temp file and hand back its descriptor.
 *
 * 0600 is set at `O_CREAT` rather than by a follow-up `chmod`: the window
 * between create and chmod is a window in which a shared temp dir exposes a
 * file another user can write, and a swapped filter is a filter nobody
 * reviewed. `O_EXCL` closes the other half — a predictable name a symlink can
 * pre-plant.
 */
function stageSeccompFilter(bytes: Buffer, tmpDir: string): { path: string; fd: number } {
  const p = path.join(tmpDir, `nemo-seccomp-${process.pid}-${randomBytes(6).toString("hex")}`)
  const fd = fs.openSync(p, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600)
  try {
    fs.writeSync(fd, bytes)
  } catch (error) {
    try {
      fs.closeSync(fd)
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(p)
    } catch {
      /* ignore */
    }
    throw error
  }
  return { path: p, fd }
}

function currentArch(): "x86_64" | "aarch64" {
  return process.arch === "arm64" ? "aarch64" : "x86_64"
}

/**
 * bubblewrap argument list, split out so flag construction is testable on
 * hosts without bwrap (Codex parity: codex-rs/linux-sandbox/src/bwrap.rs).
 *
 * The read/write mode of the workspace bind used to be hardcoded `--bind cwd cwd`
 * — always read-write — because the filesystem policy never reached this
 * function. A `read-only` session therefore had a writable workspace while being
 * told `isSandboxed: true`.
 *
 * Kept as a thin wrapper over `linuxSandboxArgs` so the exported name and
 * signature existing tests use stay intact.
 */
export function landlockArgs(
  command: string[],
  cwd: string,
  networkPolicy?: NetworkSandboxPolicy,
  filesystemPolicy?: FileSystemSandboxPolicy,
  hardening?: LinuxHardening,
): string[] {
  const writable = writableRootsAfterCarveOut(filesystemPolicy)
  // The working directory has to be visible even when the policy grants no write
  // access to it, otherwise `--chdir cwd` fails and the command cannot start. It
  // is read-only in that case, which is the whole point.
  const readOnly = writable.some((root) => isInside(cwd, root))
    ? LINUX_SYSTEM_ROOTS
    : [...LINUX_SYSTEM_ROOTS, cwd]
  return linuxSandboxArgs(
    command,
    cwd,
    writable,
    readOnly,
    networkPolicy?.disableNetwork === true,
    // Gated on `seccompApplied`, not merely on a descriptor being present. The two
    // are set together today, but gating on the FLAG is what makes the invariant
    // hold if a future path ever produces a descriptor without a filter behind it
    // — a `--seccomp` pointing at an empty or short file installs no rules while
    // the spawn reports full hardening.
    hardening?.seccompApplied ? hardening.seccompFd : undefined,
    hardening?.extraFlags ?? [],
  )
}

/**
 * Windows AppContainer OS sandbox (windows-ac.ts has the verified recipe).
 *
 * Pre-flights the workload (ac-workload.ts: MSYS/Cygwin-linked binaries
 * cannot initialize inside an AppContainer), spawns the PowerShell shim,
 * waits for the status handshake that proves an AppContainer child is
 * genuinely running, then reports `isSandboxed: true` backed by kernel
 * enforcement: default-deny NTFS ACLs, Low integrity, no user SID,
 * spawn-time network capability SIDs. The child inherits the shim's pipe
 * handles, so `readAll`/`waitForExit` stream bytes exactly like every other
 * backend. Kill escalates to `taskkill /T` so the sandboxed command dies
 * with its shim. Any failure — unrunnable workload or infrastructure —
 * falls back to an honest unsandboxed spawn (`isSandboxed: false`, with the
 * stamps rewritten and a `fallbackReason`) instead of claiming isolation
 * that was not applied.
 */

/** Fallback reason: the workload links a runtime the container cannot host. */
const MSYS_CYGWIN_FALLBACK_REASON = "msys/cygwin shell cannot run under windows-restricted isolation"
/** Fallback reason: the AppContainer shim never proved a sandboxed child. */
const HANDSHAKE_FALLBACK_REASON = "windows appcontainer handshake failed"

/**
 * Honest policy-only fallback: the command runs without OS isolation, the
 * child's sandbox-metadata stamps are rewritten so it cannot claim
 * isolation that was not applied (bash builds its env for the OS path
 * before the spawn), and the handle carries `fallbackReason` so tool output
 * can say why. spawn.ts is an allowlisted owner of the NEMO_* stamps —
 * see .github/workflows/check-forbidden-strings.yml.
 */
async function fallbackUnsandboxed(request: SpawnRequest, fallbackReason: string): Promise<SpawnedProcess> {
  const env = { ...request.env }
  env["NEMO_SANDBOX"] = "policy-only"
  delete env["NEMO_SANDBOX_NETWORK_DISABLED"]
  const proc = await spawnUnsandboxed(request.command, request.cwd, env, request.outputCap, request.signal)
  proc.fallbackReason = fallbackReason
  return proc
}

async function spawnUnderWindowsAppContainer(request: SpawnRequest): Promise<SpawnedProcess> {
  const { command, cwd, env, networkPolicy, filesystemPolicy, outputCap, signal } = request

  // Pre-flight before anything expensive: a shell that links the MSYS or
  // Cygwin runtime dies in the container's denied \BaseNamedObjects write
  // before its first instruction, and Git-bash is the shell
  // detectDefaultShell() prefers on Windows — without this check every
  // bash run fails with a fatal error the user cannot act on.
  if (acWorkloadIncompatible(command[0] ?? "", cwd)) {
    return fallbackUnsandboxed(request, MSYS_CYGWIN_FALLBACK_REASON)
  }
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
    return fallbackUnsandboxed(request, HANDSHAKE_FALLBACK_REASON)
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
  return process.env.NEMO_SANDBOX !== undefined || process.env.NEMO_SANDBOX_NETWORK_DISABLED !== undefined
}
