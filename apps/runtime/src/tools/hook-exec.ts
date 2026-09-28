/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { exec } from "child_process"
import {
  matchesMatcher,
  mergeHookOutputs,
  runHook,
  type CommandHook,
  type HookShellExecutor,
  type MergedHookOutcome,
} from "../../../../skt/14-hooks/index.js"
import type { TrayambakConfig } from "../config.js"

export type { HookShellExecutor }

/** Default per-hook ceiling: hooks gate tool calls, so they must be fast. */
export const HOOK_DEFAULT_TIMEOUT_MS = 30_000
/** Cap on hook stdout/stderr captured per run. */
const HOOK_OUTPUT_CAP = 32_000

function sliceCap(text: string): string {
  return text.length > HOOK_OUTPUT_CAP ? text.slice(0, HOOK_OUTPUT_CAP) + "\n…[truncated]" : text
}

/** Shell executor for hook commands (user-authored config, same trust as
 *  skill `command` entries): bounded time, bounded output, abort kills. */
export const execHookShell: HookShellExecutor = {
  run: ({ command, timeoutMs, signal, workdir, env }) =>
    new Promise((resolve) => {
      const child = exec(
        command,
        {
          cwd: workdir,
          env: { ...process.env, ...(env ?? {}) },
          timeout: timeoutMs,
          maxBuffer: HOOK_OUTPUT_CAP * 2,
          windowsHide: true,
          signal,
        },
        (error, stdout, stderr) => {
          resolve({
            exitCode: error ? 1 : 0,
            stdout: { text: sliceCap(String(stdout ?? "")) },
            stderr: { text: sliceCap(String(stderr ?? (error instanceof Error ? error.message : ""))) },
          })
        },
      )
      if (signal) {
        const onAbort = (): void => {
          try {
            child.kill("SIGKILL")
          } catch {
            /* already gone */
          }
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener("abort", onAbort, { once: true })
      }
    }),
}

export interface HookPointInput {
  toolName: string
  args: unknown
  cwd: string
  signal?: AbortSignal
  sessionId?: string
}

function matchedHooks(
  groups: Array<{ matcher?: string; hooks: CommandHook[] }> | undefined,
  toolName: string,
): CommandHook[] {
  if (!groups) return []
  const out: CommandHook[] = []
  for (const g of groups) {
    let ok = false
    try {
      ok = matchesMatcher(g.matcher, toolName)
    } catch {
      ok = false
    }
    if (ok) out.push(...g.hooks)
  }
  return out
}

function payloadFor(toolName: string, args: unknown, sessionId?: string): Record<string, unknown> {
  return {
    tool_name: toolName,
    tool_input: args ?? {},
    ...(sessionId ? { session_id: sessionId } : {}),
  }
}

export interface PreToolUseVerdict extends MergedHookOutcome {
  /** True when at least one hook ran (vs no configured hooks at all). */
  ran: boolean
}

/** Run PreToolUse hooks for a tool call; merge decisions (deny > ask > allow). */
export async function runPreToolUseHooks(
  config: TrayambakConfig,
  input: HookPointInput,
  executor: HookShellExecutor = execHookShell,
): Promise<PreToolUseVerdict> {
  const hooks = matchedHooks(config.hooks?.preToolUse, input.toolName)
  if (hooks.length === 0) {
    return { decision: "none", stop: false, additionalContext: [], systemMessages: [], ran: false }
  }
  const outputs = []
  for (const hook of hooks) {
    const { output } = await runHook(
      executor,
      hook,
      {
        payload: payloadFor(input.toolName, input.args, input.sessionId),
        cwd: input.cwd,
        signal: input.signal ?? new AbortController().signal,
        trailingNewline: true,
        defaultTimeoutMs: HOOK_DEFAULT_TIMEOUT_MS,
        expectedEventName: "PreToolUse",
      },
      () => Date.now(),
    )
    outputs.push(output)
    if (output.continue === false) break
  }
  return { ...mergeHookOutputs(outputs), ran: true }
}

/** Run PostToolUse hooks; context only, never blocks. Failures are silent. */
export async function runPostToolUseHooks(
  config: TrayambakConfig,
  input: HookPointInput,
  executor: HookShellExecutor = execHookShell,
): Promise<string[]> {
  const hooks = matchedHooks(config.hooks?.postToolUse, input.toolName)
  const context: string[] = []
  for (const hook of hooks) {
    try {
      const { output } = await runHook(
        executor,
        hook,
        {
          payload: payloadFor(input.toolName, input.args, input.sessionId),
          cwd: input.cwd,
          signal: input.signal ?? new AbortController().signal,
          trailingNewline: true,
          defaultTimeoutMs: HOOK_DEFAULT_TIMEOUT_MS,
          expectedEventName: "PostToolUse",
        },
        () => Date.now(),
      )
      if (output.additionalContext) context.push(output.additionalContext)
    } catch {
      /* post-hooks never break the turn */
    }
  }
  return context
}
