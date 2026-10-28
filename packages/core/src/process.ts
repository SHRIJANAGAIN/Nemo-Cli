/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Portions derived from OpenAI Codex CLI (codex-rs), Copyright 2025 OpenAI,
 * licensed under the Apache License, Version 2.0. See THIRD_PARTY_NOTICES.md.
 */

/**
 * Process management — handles process lifecycle, output capping,
 * process group killing, and timeout enforcement.
 *
 * Mirrors codex-rs/core/exec.rs and codex-rs/core/spawn.rs in Rust.
 */

import { ChildProcess, spawn } from "child_process"
import { execSync } from "child_process"

/** Default exec command timeout in milliseconds. */
export const DEFAULT_EXEC_COMMAND_TIMEOUT_MS = 10_000

/** IO drain timeout in milliseconds. */
export const IO_DRAIN_TIMEOUT_MS = 2_000

/** Maximum bytes retained from exec stdout/stderr/aggregated output. */
export const EXEC_OUTPUT_MAX_BYTES = 256 * 1024 // 256KB

/** Limit the number of ExecCommandOutputDelta events per exec call. */
export const MAX_EXEC_OUTPUT_DELTAS_PER_CALL = 10_000

/** Grace period before force kill on cancellation (ms). */
export const CANCELLATION_TERMINATION_GRACE_PERIOD_MS = 50

/** Exit code for timeout. */
export const EXEC_TIMEOUT_EXIT_CODE = 124

/** Exit code for signal termination. */
export const EXIT_CODE_SIGNAL_BASE = 128

/**
 * Exec expiration types.
 */
export enum ExecExpiration {
  Timeout = "timeout",
  DefaultTimeout = "defaultTimeout",
  Cancellation = "cancellation",
  TimeoutOrCancellation = "timeoutOrCancellation",
}

/**
 * Execution capture policy.
 */
export enum ExecCapturePolicy {
  ShellTool = "shellTool",
  FullBuffer = "fullBuffer",
}

/**
 * Process manager — tracks and manages child processes.
 */
export class ProcessManager {
  private activeProcesses: Map<number, { child: ChildProcess; timeout: ReturnType<typeof setTimeout> | null }> =
    new Map()

  /**
   * Spawn a child process with full lifecycle management.
   *
   * The handle resolves as soon as the child exists. Completion is reported
   * by `exitCode`: it resolves with the process exit code, or rejects when
   * the command times out, is aborted, or when `signal` was already aborted
   * before the call (in which case this method itself rejects).
   */
  spawn(options: {
    command: string[]
    cwd: string
    env: Record<string, string>
    timeoutMs?: number
    outputCap?: number
    processGroup?: boolean
    signal?: AbortSignal
    /** Windows: join argv into the command line exactly as given, no CRT
     *  quoting/escaping. Required for the `[shell, /c, <raw command>]`
     *  pattern: CRT-escaping turns the user's own quotes into `\"`, which
     *  cmd.exe does not understand (it mangles `echo "hi"` into `\"hi\"`
     *  and silently no-ops `node -e "code"`, #75). Leave unset for direct
     *  argv (`[exe, ...args]`) — CRT quoting is what makes spaced exe
     *  paths work there. Ignored on Unix. */
    windowsVerbatimArguments?: boolean
  }): Promise<{
    pid: number
    exitCode: Promise<number>
    output: Promise<string>
    kill: (signal?: string) => Promise<void>
  }> {
    const {
      command,
      cwd,
      env,
      timeoutMs = DEFAULT_EXEC_COMMAND_TIMEOUT_MS,
      outputCap = EXEC_OUTPUT_MAX_BYTES,
      processGroup,
      signal,
      windowsVerbatimArguments,
    } = options

    return new Promise((resolve, reject) => {
      // Already cancelled: nothing to run. Reject outright instead of
      // spawning a corpse and handing back a handle to it.
      if (signal?.aborted) {
        reject(new Error("Process aborted"))
        return
      }

      // `processGroup` (bash passes true) makes a POSIX child its own
      // process-group leader so killProcessGroup's `process.kill(-pid)`
      // reaches grandchildren; without it the group kill silently misses
      // (ESRCH) and only the direct child dies. Windows kills the whole
      // tree with `taskkill /T` and needs no detached child.
      const ownProcessGroup = processGroup === true && process.platform !== "win32"
      const child = spawn(command[0], command.slice(1), {
        cwd,
        env,
        windowsHide: true,
        detached: ownProcessGroup,
        windowsVerbatimArguments,
      })

      const pid = child.pid ?? 0
      let timeout: ReturnType<typeof setTimeout> | null = null

      const output = this.readOutputWithCap(child, outputCap)

      const exitCode = new Promise<number>((resolveExit, rejectExit) => {
        // Completion settles exactly once: the first of close/error/timeout/
        // abort wins, later events are no-ops. Timeout and abort reject with
        // a real error so callers can tell them apart from an exit 1.
        let completionSettled = false
        let onAbort: (() => void) | undefined

        const finish = (error: Error | null, code: number | null): void => {
          if (completionSettled) return
          completionSettled = true
          if (timeout) clearTimeout(timeout)
          if (signal && onAbort) signal.removeEventListener("abort", onAbort)
          this.activeProcesses.delete(pid)
          if (error) rejectExit(error)
          else resolveExit(code ?? 1)
        }

        if (timeoutMs > 0) {
          timeout = setTimeout(() => {
            this.forceKill(child, pid)
            finish(new Error(`Command timed out after ${timeoutMs}ms`), null)
          }, timeoutMs)
        }

        if (signal) {
          onAbort = () => {
            this.forceKill(child, pid)
            finish(new Error("Process aborted"), null)
          }
          // The signal is deliberately NOT forwarded to child_process: Node
          // registers its abort listener inside spawn(), before this one, and
          // emits the child's 'error' synchronously — which would settle
          // exitCode first and swallow the rejection. Owning the listener
          // keeps the settle order deterministic: abort rejects, close/error
          // defer to the guard above.
          signal.addEventListener("abort", onAbort, { once: true })
        }

        child.on("close", (code: number | null) => finish(null, code))
        child.on("error", () => finish(null, 1))
      })

      // Timeout/abort must not crash a caller that walked away (bash.ts
      // resolves on its own timer and never awaits exitCode — an unhandled
      // rejection there is fatal on Node ≥15). This observer marks the
      // rejection handled; later awaiters still receive it.
      exitCode.catch(() => {})

      this.activeProcesses.set(pid, { child, timeout })

      resolve({
        pid,
        exitCode,
        output,
        kill: (sig?: string | NodeJS.Signals) => this.forceKill(child, pid, sig as NodeJS.Signals),
      })
    })
  }

  /**
   * Kill a process and its entire process group.
   */
  async killProcessGroup(pid: number, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
    if (process.platform === "win32") {
      // Windows: use taskkill to kill process tree
      try {
        execSync(`taskkill /T /F /PID ${pid}`, { windowsHide: true, timeout: 5_000 })
      } catch {
        /* process already dead */
      }
    } else {
      // Unix: kill negative PID (process group)
      try {
        process.kill(-pid, signal)
      } catch {
        /* process group already dead */
      }
    }
  }

  /**
   * Force kill a process and its children.
   */
  private async forceKill(child: ChildProcess, pid: number, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
    try {
      await this.killProcessGroup(pid, signal)
    } catch {
      /* ignore */
    }
    try {
      child.kill(signal)
    } catch {
      /* ignore */
    }
  }

  /**
   * Read process output with byte cap.
   */
  private readOutputWithCap(child: ChildProcess, maxBytes: number): Promise<string> {
    return new Promise((resolve) => {
      let output = ""
      let byteCount = 0
      let deltaCount = 0

      const drain = (stream: NodeJS.ReadableStream | null) => {
        if (!stream) return
        const destroyable = stream as NodeJS.ReadableStream & { destroy?: () => void }
        stream.on("data", (chunk: Buffer) => {
          if (byteCount >= maxBytes) return
          const chunkStr = chunk.toString("utf8")
          const remaining = maxBytes - byteCount
          output += chunkStr.slice(0, remaining)
          byteCount += chunk.length
          deltaCount++
          if (deltaCount >= MAX_EXEC_OUTPUT_DELTAS_PER_CALL) {
            destroyable.destroy?.()
          }
        })
      }

      drain(child.stdout)
      drain(child.stderr)

      const timeout = setTimeout(() => resolve(output), IO_DRAIN_TIMEOUT_MS)
      child.on("close", () => {
        clearTimeout(timeout)
        resolve(output)
      })
      child.on("error", () => {
        clearTimeout(timeout)
        resolve(output)
      })
    })
  }

  /**
   * Get count of active processes.
   */
  get activeCount(): number {
    return this.activeProcesses.size
  }

  /**
   * Kill all active processes.
   */
  async killAll(): Promise<void> {
    for (const [pid, { child }] of this.activeProcesses) {
      await this.forceKill(child, pid)
    }
    this.activeProcesses.clear()
  }
}

/**
 * Create a cancellation token that can be used for process timeout.
 */
export function createCancellationToken(): {
  token: AbortController
  cancel: () => void
  isCancelled: () => boolean
} {
  const controller = new AbortController()
  return {
    token: controller,
    cancel: () => controller.abort(),
    isCancelled: () => controller.signal.aborted,
  }
}

/**
 * Combine two cancellation tokens.
 */
export function combineTokens(a: AbortController, b: AbortController): AbortController {
  const combined = new AbortController()
  a.signal.addEventListener("abort", () => combined.abort(), { once: true })
  b.signal.addEventListener("abort", () => combined.abort(), { once: true })
  return combined
}
