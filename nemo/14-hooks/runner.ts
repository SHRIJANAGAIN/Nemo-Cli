/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Execute command hooks through the shell executor, using its credential scrub,
 * process-group cancellation, and timeout machinery. The runner supplies the
 * trusted stdin payload and environment, then this module decodes the captured
 * outcome.
 * @module nemo/14-hooks/runner
 */

import type { HookOutput } from "./types.js"
import type { CommandHook } from "./types.js"
import { parseHookOutput } from "./codec.js"

/**
 * The reference default per-hook timeout, in ms (10 minutes) — the value
 * Nemo applies to a hook whose config sets no `timeout`.
 */
export const DEFAULT_HOOK_TIMEOUT_MS = 600_000

/** Everything a single hook invocation needs beyond its command line. */
export interface RunHookOptions {
  /** The JSON payload object written to the hook's stdin (the caller builds it). */
  payload: unknown
  /** Extra env vars for the hook process; the caller builds these. */
  env?: Record<string, string>
  /** Working directory for the hook. */
  cwd?: string
  /** Explicit owning-operation signal; firing it cancels the hook run. */
  readonly signal: AbortSignal
  /** Whether to append a trailing newline to the stdin payload. */
  trailingNewline: boolean
  /**
   * Timeout applied when the hook's config sets no `timeout` of its own.
   * DEFAULT_HOOK_TIMEOUT_MS is the reference default.
   */
  defaultTimeoutMs: number
  /**
   * The event this hook is firing for (e.g. `'PreToolUse'`). When set, a
   * structured `hookSpecificOutput` block whose `hookEventName` names a DIFFERENT
   * event is treated as malformed and its event-scoped fields are discarded.
   * Omit to apply any block as-is.
   */
  expectedEventName?: string
}

/** The {@link HookOutput} plus the wall-clock duration of the run. */
export interface RunHookResult {
  output: HookOutput
  /** Wall-clock duration of the run. */
  durationMs: number
}

/**
 * A minimal shell executor interface that runs a command with stdin, timeout, and
 * abort signal, returning exit code and captured stdout/stderr.
 */
export interface HookShellExecutor {
  run(options: {
    command: string
    timeoutMs: number
    stdin: string
    signal: AbortSignal
    workdir?: string
    env?: Record<string, string>
  }): Promise<{
    exitCode: number | null
    stdout: { text: string }
    stderr: { text: string }
  }>
}

/**
 * Run `hook` with serialized stdin and decode its outcome. A hook-specific
 * timeout in seconds overrides the default; trusted environment entries merge
 * after the executor scrub. Infrastructure rejection becomes an outcome with
 * no exit code, so this function never throws or crashes the calling turn.
 * @param bash - The shell executor that the command runs through.
 * @param hook - the configured command; its `timeoutSec` (wire unit: seconds) overrides the default timeout.
 * @param options - the invocation's payload, env, cwd, signal, stdin framing, and default timeout.
 * @param now - millisecond clock used for the reported duration.
 * @returns the decoded output plus the run's wall-clock duration.
 */
export async function runHook(
  bash: HookShellExecutor,
  hook: CommandHook,
  options: RunHookOptions,
  now: () => number,
): Promise<RunHookResult> {
  const started = now()
  const timeoutMs = hook.timeoutSec !== undefined ? hook.timeoutSec * 1000 : options.defaultTimeoutMs
  const stdin = JSON.stringify(options.payload) + (options.trailingNewline ? "\n" : "")

  const request = {
    command: hook.command,
    timeoutMs,
    stdin,
    signal: options.signal,
    ...(options.cwd !== undefined ? { workdir: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  }

  try {
    const result = await bash.run(request)
    const exitCode = result.exitCode ?? undefined
    return {
      output: parseHookOutput(exitCode, result.stdout.text, result.stderr.text, options.expectedEventName),
      durationMs: now() - started,
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      output: parseHookOutput(undefined, "", message, options.expectedEventName),
      durationMs: now() - started,
    }
  }
}

/**
 * Quiescence tracking for emit-shaped hook runs that no extension point awaits.
 * The tracker holds the run plus its continuation, passes the tracker signal
 * into execution, and drains on disposal so no process or late callback
 * outlives the fiber.
 */
export interface DetachedRuns {
  /**
   * The abort signal every tracked run must hand to {@link runHook} (via its
   * `signal` option). {@link drain} fires it so a still-running hook process
   * is killed rather than awaited out to its timeout.
   */
  readonly signal: AbortSignal
  /**
   * Register one detached run until it settles. Pass the FULL chain — the hook
   * run and its continuation/error handler — so {@link drain} waits for the
   * side effects (a warn, a log), not just the process exit.
   */
  track(run: Promise<unknown>): void
  /**
   * Abort {@link signal}, then resolve once every tracked chain has settled.
   * @returns resolves when all tracked runs have settled.
   */
  drain(): Promise<void>
}

/**
 * Create a {@link DetachedRuns} tracker (one per bridge `apply()`); settled
 * runs are pruned so a long-lived session does not accumulate them.
 */
export function createDetachedRuns(): DetachedRuns {
  const inflight = new Set<Promise<unknown>>()
  const controller = new AbortController()
  return {
    signal: controller.signal,
    track(run: Promise<unknown>): void {
      inflight.add(run)
      const settled = (): void => {
        inflight.delete(run)
      }
      void run.then(settled, settled)
    },
    async drain(): Promise<void> {
      controller.abort(new Error("hook bridge disposed"))
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight])
      }
    },
  }
}
