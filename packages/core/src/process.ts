/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

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
   */
  spawn(options: {
    command: string[]
    cwd: string
    env: Record<string, string>
    timeoutMs?: number
    outputCap?: number
    processGroup?: boolean
    signal?: AbortSignal
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
      signal,
    } = options

    return new Promise((resolve, reject) => {
      const child = spawn(command[0], command.slice(1), {
        cwd,
        env,
        signal,
        windowsHide: true,
      })

      const pid = child.pid ?? 0
      let timeout: ReturnType<typeof setTimeout> | null = null

      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          this.forceKill(child, pid)
          reject(new Error(`Command timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }

      if (signal) {
        signal.addEventListener("abort", () => {
          this.forceKill(child, pid)
          reject(new Error("Process aborted"))
        })
      }

      const output = this.readOutputWithCap(child, outputCap)

      const exitCode = new Promise<number>((resolveExit) => {
        child.on("close", (code: number | null) => {
          if (timeout) clearTimeout(timeout)
          this.activeProcesses.delete(pid)
          resolveExit(code ?? 1)
        })
        child.on("error", () => {
          if (timeout) clearTimeout(timeout)
          this.activeProcesses.delete(pid)
          resolveExit(1)
        })
      })

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
        execSync(`taskkill /T /F /PID ${pid}`, { windowsHide: true })
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
