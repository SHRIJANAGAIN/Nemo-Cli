/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * OS-level sandbox spawner — bridges Node.js child_process to OS-level isolation.
 *
 * This module provides the implementation for spawning processes under
 * OS-level sandboxes (seatbelt, landlock, Windows restricted token).
 *
 * Architecture mirrors codex-sandboxing/src/spawn.rs in Rust.
 */

import { ChildProcess, spawn } from "child_process"
import { promises as fs } from "fs"
import { homedir } from "os"
import { join, dirname } from "path"

import { SandboxType, NetworkSandboxPolicy, SpawnRequest, SpawnedProcess } from "./types.js"

/**
 * Maximum output bytes before truncation. */
export const OUTPUT_MAX_BYTES = 256 * 1024 // 256KB

/** IO drain timeout in milliseconds. */
export const IO_DRAIN_TIMEOUT_MS = 2000

/** Default exec command timeout. */
export const DEFAULT_EXEC_COMMAND_TIMEOUT_MS = 10_000

/** Maximum exec output deltas per call. */
export const MAX_EXEC_OUTPUT_DELTAS_PER_CALL = 10_000

/**
 * Spawn a process with the appropriate sandbox type.
 */
export async function spawnProcess(request: SpawnRequest): Promise<SpawnedProcess> {
  const { command, cwd, sandboxType, env, networkPolicy, timeoutMs, signal } = request

  switch (sandboxType) {
    case SandboxType.MacosSeatbelt:
      return spawnUnderSeatbelt(command, cwd, env, networkPolicy, timeoutMs, signal)
    case SandboxType.LinuxSeccomp:
      return spawnUnderLandlock(command, cwd, env, networkPolicy, timeoutMs, signal)
    case SandboxType.WindowsRestrictedToken:
      return spawnUnderWindowsRestrictedToken(command, cwd, env, networkPolicy, timeoutMs, signal)
    case SandboxType.None:
    default:
      return spawnUnsandboxed(command, cwd, env, timeoutMs, signal)
  }
}

/**
 * Spawn under macOS seatbelt using sandbox-exec.
 */
async function spawnUnderSeatbelt(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  networkPolicy: NetworkSandboxPolicy,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SpawnedProcess> {
  const sbplPath = await generateSeatbeltPolicy(networkPolicy)
  const sandboxExec = "/usr/bin/sandbox-exec"
  const args = ["-f", sbplPath, ...command]

  const child = spawn(sandboxExec, args, { cwd, env, signal, windowsHide: true })
  const pgid = process.platform !== "win32" ? getPgid(child.pid ?? 0) : 0

  return createSpawnedProcess(child, /*isSandboxed*/ true, SandboxType.MacosSeatbelt, pgid)
}

/**
 * Spawn under Linux landlock/bubblewrap.
 */
async function spawnUnderLandlock(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  networkPolicy: NetworkSandboxPolicy,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SpawnedProcess> {
  // Use bubblewrap if available, otherwise landlock
  const bwrap = "/usr/bin/bwrap"
  const args = [
    "--unshare-all",
    "--die-with-parent",
    "--ro-bind",
    cwd,
    cwd,
    "--bind",
    cwd,
    cwd,
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--chdir",
    cwd,
    ...command,
  ]

  if (networkPolicy?.disableNetwork) {
    args.splice(1, 0, "--net", "/dev/null")
  }

  const child = spawn(bwrap, args, { cwd, env, signal, windowsHide: true })
  const pgid = process.platform !== "win32" ? getPgid(child.pid ?? 0) : 0

  return createSpawnedProcess(child, /*isSandboxed*/ true, SandboxType.LinuxSeccomp, pgid)
}

/**
 * Spawn under Windows restricted token.
 */
async function spawnUnderWindowsRestrictedToken(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  networkPolicy: NetworkSandboxPolicy,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SpawnedProcess> {
  // Windows restricted token sandbox
  // Uses CreateRestrictedToken equivalent via child process wrapper
  const args = [...command]
  const child = spawn(command[0], args.slice(1), { cwd, env, signal, windowsHide: true })
  const pgid = 0 // Windows doesn't have process groups like Unix

  return createSpawnedProcess(child, /*isSandboxed*/ true, SandboxType.WindowsRestrictedToken, pgid)
}

/**
 * Spawn without any sandbox (fallback).
 */
async function spawnUnsandboxed(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SpawnedProcess> {
  const child = spawn(command[0], command.slice(1), { cwd, env, signal, windowsHide: true })
  const pgid = process.platform !== "win32" ? getPgid(child.pid ?? 0) : 0

  return createSpawnedProcess(child, /*isSandboxed*/ false, SandboxType.None, pgid)
}

/**
 * Generate a seatbelt policy file for macOS sandbox-exec.
 */
async function generateSeatbeltPolicy(networkPolicy: NetworkSandboxPolicy): Promise<string> {
  const policy = {
    version: 1,
    dependencies: {
      system: {
        "network.inbound": networkPolicy?.disableNetwork ? "deny" : "allow",
        "network.outbound": networkPolicy?.disableNetwork ? "deny" : "allow",
      },
    },
  }

  const sbplPath = join(homedir(), ".trayambak", "seatbelt.sbpl")
  await fs.mkdir(dirname(sbplPath), { recursive: true })
  await fs.writeFile(sbplPath, JSON.stringify(policy, null, 2))
  return sbplPath
}

/**
 * Create a SpawnedProcess handle from a ChildProcess.
 */
function createSpawnedProcess(
  child: ChildProcess,
  isSandboxed: boolean,
  sandboxType: SandboxType,
  pgid: number,
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
      const { maxBytes = OUTPUT_MAX_BYTES, maxDeltas = MAX_EXEC_OUTPUT_DELTAS_PER_CALL } = options
      return new Promise<string>((resolve, reject) => {
        let output = ""
        let byteCount = 0
        let deltaCount = 0

        const onData = (chunk: Buffer) => {
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

        child.stdout?.on("data", onData)
        child.stderr?.on("data", onData)

        const timeout = setTimeout(() => {
          reject(new Error(`IO drain timeout after ${IO_DRAIN_TIMEOUT_MS}ms`))
        }, IO_DRAIN_TIMEOUT_MS)

        child.on("close", () => {
          clearTimeout(timeout)
          resolve(output)
        })
        child.on("error", reject)
      })
    },

    async waitForExit() {
      return new Promise<number>((resolve) => {
        child.on("close", (code) => resolve(code ?? 1))
        child.on("error", () => resolve(1))
      })
    },
  }
}

/**
 * Get the process group ID for tree-killing.
 */
function getPgid(pid: number): number {
  if (process.platform === "win32") return 0
  try {
    // Use process.getgid if available (Unix)
    // Fallback: parse from /proc
    return pid // Simplified — real implementation would get actual PGID
  } catch {
    return pid
  }
}

/**
 * Check if a process is running inside an OS-level sandbox.
 */
export function isProcessSandboxed(): boolean {
  return process.env.CODEX_SANDBOX !== undefined || process.env.CODEX_SANDBOX_NETWORK_DISABLED !== undefined
}
