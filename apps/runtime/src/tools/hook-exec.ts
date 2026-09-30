/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
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
import {
  getHookRuntime,
  registerDefaultHooks,
  HookEventName,
  HookSource,
  type HookContext,
} from "../../../../packages/core/src/hook_runtime.js"
import { redactPayload } from "../../../../packages/core/src/secrets.js"
import { getSafeEnv } from "../../../../packages/core/src/env_filter.js"
import type { TrayambakConfig } from "../config.js"

export type { HookShellExecutor }

/** Default per-hook ceiling: hooks gate tool calls, so they must be fast. */
export const HOOK_DEFAULT_TIMEOUT_MS = 30_000
/** Cap on hook stdout/stderr captured per run. */
const HOOK_OUTPUT_CAP = 32_000

function sliceCap(text: string): string {
  return text.length > HOOK_OUTPUT_CAP ? text.slice(0, HOOK_OUTPUT_CAP) + "\n…[truncated]" : text
}

/** Environment handed to hook child processes. Hooks are user-authored shell
 *  commands, but inheriting the FULL parent environment would hand them every
 *  API key in the process (`TRAYAMBAK_API_KEY`, `OPENAI_API_KEY`, …) — so the
 *  inherited env runs through `getSafeEnv` first (credential-shaped names are
 *  dropped, `PATH`/`HOME`/… survive), then config-declared extras merge on top
 *  (those are explicit, operator-supplied values). Exported for tests. */
export function hookChildEnv(extra?: Record<string, string>): Record<string, string> {
  return { ...getSafeEnv(process.env), ...(extra ?? {}) }
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
          env: hookChildEnv(env),
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

/** Build the JSON payload a config shell hook reads on stdin. Redacted at the
 *  boundary: a hook subprocess must never receive raw credential material
 *  (`apiKey`/`token` keys → `"****"`, embedded `sk-…`/`Bearer …` →
 *  `[REDACTED]`) while ordinary tool arguments — long paths, commands, prose —
 *  pass through byte-for-byte (`redactPayload` never truncates). */
function payloadFor(toolName: string, args: unknown, sessionId?: string): Record<string, unknown> {
  return {
    tool_name: toolName,
    tool_input: redactPayload(args ?? {}),
    ...(sessionId ? { session_id: sessionId } : {}),
  }
}

/** True when at least one CONFIG shell hook ran (vs no configured hooks at
 *  all). The programmatic HookRuntime layer reports through `decision`,
 *  `stop`, and `additionalContext` instead — a no-op registration must not
 *  flip this flag, or "no configured hooks" verdicts would silently change. */
export interface PreToolUseVerdict extends MergedHookOutcome {
  ran: boolean
}

/** Programmatic (in-process) hook layer: handlers registered with the core
 *  HookRuntime (plugins, embedders, tests) run on every pre/post tool point
 *  alongside config `hooks.*` shell commands. Deny wins across both layers;
 *  context accumulates from both. The three extension-point defaults
 *  (permission-check, telemetry-record, session-init) register once per
 *  process — a `getHookRuntime().clear()` (test isolation) intentionally
 *  empties the registry and is not re-seeded behind the caller's back. */
let defaultsRegistered = false
function ensureDefaultHooks(): void {
  if (defaultsRegistered) return
  registerDefaultHooks()
  defaultsRegistered = true
}

function buildRuntimeContext(config: TrayambakConfig, input: HookPointInput, eventName: HookEventName): HookContext {
  return {
    eventName,
    source: HookSource.System,
    toolName: input.toolName,
    args: (input.args ?? {}) as Record<string, unknown>,
    sessionId: input.sessionId,
    cwd: input.cwd,
    // Structural casts: TrayambakConfig is a closed interface; the runtime
    // treats config/permissions as opaque records and never narrows them.
    config: config as unknown as Record<string, unknown>,
    permissions: (config.permissions ?? {}) as unknown as Record<string, unknown>,
  }
}

/** Run PreToolUse hooks for a tool call; merge decisions (deny > ask > allow).
 *  Order: programmatic HookRuntime first (in-process, fast-fail — a registered
 *  hook that denies skips every shell subprocess), then config shell hooks. */
export async function runPreToolUseHooks(
  config: TrayambakConfig,
  input: HookPointInput,
  executor: HookShellExecutor = execHookShell,
): Promise<PreToolUseVerdict> {
  ensureDefaultHooks()

  const runtime = getHookRuntime()
  let runtimeContexts: string[] = []
  if (runtime.getHooksForEvent(HookEventName.PreToolUse).length > 0) {
    const verdict = await runtime.evaluatePreToolUse(
      input.toolName,
      (input.args ?? {}) as Record<string, unknown>,
      buildRuntimeContext(config, input, HookEventName.PreToolUse),
    )
    runtimeContexts = verdict.additionalContext
    if (verdict.shouldStop || verdict.decision === "deny" || verdict.decision === "block") {
      return {
        decision: "deny",
        stop: true,
        reason: "Denied by a registered PreToolUse hook.",
        additionalContext: runtimeContexts,
        systemMessages: [],
        ran: false,
      }
    }
  }

  const hooks = matchedHooks(config.hooks?.preToolUse, input.toolName)
  if (hooks.length === 0) {
    return {
      decision: "none",
      stop: false,
      additionalContext: runtimeContexts,
      systemMessages: [],
      ran: false,
    }
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
  const merged = mergeHookOutputs(outputs)
  return {
    ...merged,
    additionalContext: [...runtimeContexts, ...merged.additionalContext],
    ran: true,
  }
}

/** Run PostToolUse hooks; context only, never blocks. Failures are silent.
 *  Config shell hooks keep their documented order first; programmatic
 *  HookRuntime observers append after — post hooks observe, never veto. */
export async function runPostToolUseHooks(
  config: TrayambakConfig,
  input: HookPointInput,
  executor: HookShellExecutor = execHookShell,
): Promise<string[]> {
  ensureDefaultHooks()

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

  const runtime = getHookRuntime()
  if (runtime.getHooksForEvent(HookEventName.PostToolUse).length > 0) {
    const summary = await runtime.runEvent(buildRuntimeContext(config, input, HookEventName.PostToolUse))
    context.push(...(summary.additionalContext ?? []))
  }
  return context
}
