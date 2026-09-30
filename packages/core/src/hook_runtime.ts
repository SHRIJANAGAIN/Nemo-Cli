/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Hook Runtime — pre/post tool use, session start/stop, user prompt submit hooks.
 *
 * Mirrors codex-rs/core/src/hook_runtime.rs in Rust.
 * Provides a full lifecycle hook system for the agent.
 */

import { redactPayload } from "./secrets.js"

/**
 * Hook source — where the hook is triggered from.
 */
export enum HookSource {
  User = "user",
  Model = "model",
  System = "system",
  Plugin = "plugin",
}

/**
 * Hook event names.
 */
export enum HookEventName {
  SessionStart = "session.start",
  SessionEnd = "session.end",
  UserPromptSubmit = "user.prompt_submit",
  PreToolUse = "tool.use",
  PostToolUse = "tool.post_use",
  Stop = "stop",
  Subagent = "subagent",
  PreCompact = "compact.pre",
  PostCompact = "compact.post",
}

/**
 * Hook execution mode.
 */
export enum HookExecutionMode {
  Blocking = "blocking",
  NonBlocking = "non_blocking",
}

/**
 * Hook run status.
 */
export enum HookRunStatus {
  Success = "success",
  Failed = "failed",
  Timeout = "timeout",
  Cancelled = "cancelled",
}

/**
 * Hook run summary.
 */
export interface HookRunSummary {
  eventName: HookEventName
  status: HookRunStatus
  durationMs: number
  output: string
  exitCode: number
  additionalContext?: string[]
}

/**
 * Pre-tool-use hook result.
 */
export enum PreToolUseHookResult {
  Allow = "allow",
  Deny = "deny",
  Ask = "ask",
  Block = "block",
}

/**
 * Post-tool-use hook outcome.
 */
export interface PostToolUseOutcome {
  toolCallId: string
  toolName: string
  outcome: "success" | "error" | "denied"
  additionalContext: string[]
  shouldStop: boolean
}

/**
 * Pre-tool-use hook outcome.
 */
export interface PreToolUseOutcome {
  toolCallId: string
  toolName: string
  outcome: PreToolUseHookResult
  additionalContext: string[]
  shouldStop: boolean
}

/**
 * Session start hook outcome.
 */
export interface SessionStartOutcome {
  shouldStop: boolean
  additionalContext: string[]
}

/**
 * Stop hook outcome.
 */
export interface StopOutcome {
  shouldStop: boolean
  reason?: string
}

/**
 * User prompt submit hook outcome.
 */
export interface UserPromptSubmitOutcome {
  shouldStop: boolean
  additionalContext: string[]
}

/**
 * Compact hook outcomes.
 */
export interface PreCompactOutcome {
  shouldBlock: boolean
  additionalContext: string[]
}

export interface PostCompactOutcome {
  shouldBlock: boolean
  additionalContext: string[]
}

/**
 * Hook execution context passed to hook handlers.
 */
export interface HookContext {
  eventName: HookEventName
  source: HookSource
  toolCallId?: string
  toolName?: string
  args?: Record<string, unknown>
  sessionId?: string
  cwd: string
  config: Record<string, unknown>
  permissions: Record<string, unknown>
}

/**
 * Hook function signature.
 */
export type HookHandler = (context: HookContext) => Promise<HookResult>

/**
 * Hook result from a handler.
 */
export interface HookResult {
  shouldStop: boolean
  additionalContext: string[]
  overrideArgs?: Record<string, unknown>
}

/**
 * Hook registration.
 */
export interface HookRegistration {
  name: string
  events: HookEventName[]
  handler: HookHandler
  mode: HookExecutionMode
  timeoutMs: number
}

/** Bounded hook history: one summary per event that actually ran a hook,
 *  oldest entries dropped past the cap. The runtime is a process-wide
 *  singleton wired into every tool call (see apps/runtime hook-exec), so
 *  long sessions must not grow this array without bound. */
export const HOOK_HISTORY_LIMIT = 200

/**
 * Redact the context a hook handler receives (AGENTS.md: "Secrets are redacted
 * before hooks"). Handlers are in-process today but routinely forward
 * `args`/`config` into a shell command payload, so the values must be clean
 * BEFORE they cross the handler boundary. `redactPayload` masks secret-named
 * keys and embedded credential material while leaving ordinary tool arguments
 * (paths, commands, prose of any length) byte-for-byte intact.
 */
function redactHookContext(context: HookContext): HookContext {
  const safe: HookContext = { ...context }
  if (context.args !== undefined) safe.args = redactPayload(context.args) as Record<string, unknown>
  safe.config = redactPayload(context.config) as Record<string, unknown>
  safe.permissions = redactPayload(context.permissions) as Record<string, unknown>
  return safe
}

/**
 * Redact hook-produced text before it leaves the runtime. `HookRunSummary`
 * output and `additionalContext` are handed back to the caller, pushed into
 * history, and can be recorded by analytics — a hook that echoes its payload
 * (or leaks a credential it saw) must not be able to write raw key material
 * into any of those sinks.
 */
function redactHookText(text: string): string {
  return redactPayload(text) as string
}

/**
 * Hook runtime — manages all lifecycle hooks.
 *
 * This is the core hook system that mirrors codex-rs/core/src/hook_runtime.rs.
 * Supports pre/post tool use, session start/stop, user prompt submit,
 * compaction, and subagent hooks.
 */
export class HookRuntime {
  private hooks: Map<string, HookRegistration> = new Map()
  private history: HookRunSummary[] = []

  /**
   * Register a hook.
   */
  register(hook: HookRegistration): void {
    this.hooks.set(hook.name, hook)
  }

  /**
   * Unregister a hook by name.
   */
  unregister(name: string): void {
    this.hooks.delete(name)
  }

  /**
   * Get all hooks registered for an event.
   */
  getHooksForEvent(event: HookEventName): HookRegistration[] {
    return Array.from(this.hooks.values()).filter((h) => h.events.includes(event))
  }

  /**
   * Run all hooks for an event.
   */
  async runEvent(context: HookContext): Promise<HookRunSummary> {
    const startTime = Date.now()
    const hooks = this.getHooksForEvent(context.eventName)
    const results = await Promise.allSettled(hooks.map((h) => this.executeHook(h, context)))

    const summary: HookRunSummary = {
      eventName: context.eventName,
      status: HookRunStatus.Success,
      durationMs: Date.now() - startTime,
      output: "",
      exitCode: 0,
      additionalContext: [],
    }

    // Collect additional context from all hooks
    for (const result of results) {
      if (result.status === "fulfilled") {
        const hookResult = result.value
        const contextLines = hookResult.additionalContext.map(redactHookText)
        if (hookResult.shouldStop) {
          summary.status = HookRunStatus.Cancelled
          summary.output = contextLines.join("\n")
          // Collect alongside the joined `output` too: evaluatePreToolUse /
          // onStop expose the two fields separately, and a denying hook's
          // explanation must reach the caller's additionalContext (it is the
          // deny reason the UI shows), not just the stop reason string.
          summary.additionalContext?.push(...contextLines)
          summary.exitCode = 1
          break
        }
        summary.additionalContext?.push(...contextLines)
      } else {
        summary.status = HookRunStatus.Failed
      }
    }

    // History only for events that actually ran a hook (an empty event is a
    // no-op, not an entry) and bounded: the runtime is a process-wide
    // singleton, so long sessions would otherwise grow this without limit.
    if (hooks.length > 0) {
      this.history.push(summary)
      while (this.history.length > HOOK_HISTORY_LIMIT) this.history.shift()
    }
    return summary
  }

  /**
   * Execute a single hook with timeout.
   */
  private async executeHook(hook: HookRegistration, context: HookContext): Promise<HookResult> {
    let timer: ReturnType<typeof setTimeout> | undefined = undefined
    const timeout = new Promise<HookResult>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Hook ${hook.name} timed out after ${hook.timeoutMs}ms`)),
        hook.timeoutMs,
      )
    })
    try {
      // Redaction boundary: the handler (and anything it shells out to) must
      // never see raw credential material in the event payload.
      return await Promise.race([hook.handler(redactHookContext(context)), timeout])
    } finally {
      // Handler won the race: cancel the timeout so its late rejection is
      // never scheduled and the timer can't hold the event loop open for the
      // full timeout window (this path runs on every tool call since
      // hook-exec wired the runtime into the live pre/post points).
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Pre-tool-use hook evaluation.
   * Returns whether the tool call should be blocked, denied, or asked.
   */
  async evaluatePreToolUse(
    toolName: string,
    args: Record<string, unknown>,
    context: HookContext,
  ): Promise<{
    decision: "allow" | "deny" | "ask" | "block"
    additionalContext: string[]
    shouldStop: boolean
  }> {
    const hookContext: HookContext = { ...context, eventName: HookEventName.PreToolUse, toolName, args }
    const summary = await this.runEvent(hookContext)

    return {
      decision: summary.status === HookRunStatus.Cancelled ? "deny" : "allow",
      additionalContext: summary.additionalContext || [],
      shouldStop: summary.status === HookRunStatus.Cancelled,
    }
  }

  /**
   * Post-tool-use hook evaluation.
   */
  async evaluatePostToolUse(
    toolCallId: string,
    toolName: string,
    outcome: "success" | "error" | "denied",
    context: HookContext,
  ): Promise<PostToolUseOutcome> {
    const hookContext: HookContext = { ...context, eventName: HookEventName.PostToolUse, toolCallId, toolName }
    const summary = await this.runEvent(hookContext)

    return {
      toolCallId,
      toolName,
      outcome,
      additionalContext: summary.additionalContext || [],
      shouldStop: summary.status === HookRunStatus.Cancelled,
    }
  }

  /**
   * Run session start hooks.
   */
  async onSessionStart(context: HookContext): Promise<SessionStartOutcome> {
    const summary = await this.runEvent({ ...context, eventName: HookEventName.SessionStart })
    return {
      shouldStop: summary.status === HookRunStatus.Cancelled,
      additionalContext: summary.additionalContext || [],
    }
  }

  /**
   * Run stop hooks.
   */
  async onStop(context: HookContext): Promise<StopOutcome> {
    const summary = await this.runEvent({ ...context, eventName: HookEventName.Stop })
    return {
      shouldStop: summary.status === HookRunStatus.Cancelled,
      reason: summary.output || undefined,
    }
  }

  /**
   * Run user prompt submit hooks.
   */
  async onUserPromptSubmit(context: HookContext): Promise<UserPromptSubmitOutcome> {
    const summary = await this.runEvent({ ...context, eventName: HookEventName.UserPromptSubmit })
    return {
      shouldStop: summary.status === HookRunStatus.Cancelled,
      additionalContext: summary.additionalContext || [],
    }
  }

  /**
   * Run pre-compaction hooks.
   */
  async onPreCompact(context: HookContext): Promise<PreCompactOutcome> {
    const summary = await this.runEvent({ ...context, eventName: HookEventName.PreCompact })
    return {
      shouldBlock: summary.status === HookRunStatus.Cancelled,
      additionalContext: summary.additionalContext || [],
    }
  }

  /**
   * Run post-compaction hooks.
   */
  async onPostCompact(context: HookContext): Promise<PostCompactOutcome> {
    const summary = await this.runEvent({ ...context, eventName: HookEventName.PostCompact })
    return {
      shouldBlock: summary.status === HookRunStatus.Cancelled,
      additionalContext: summary.additionalContext || [],
    }
  }

  /**
   * Get all hook history.
   */
  getHistory(): HookRunSummary[] {
    return [...this.history]
  }

  /**
   * Get all registered hooks.
   */
  getRegisteredHooks(): HookRegistration[] {
    return Array.from(this.hooks.values())
  }

  /**
   * Clear all hooks and history.
   */
  clear(): void {
    this.hooks.clear()
    this.history = []
  }
}

/**
 * Default hook runtime singleton.
 */
let defaultHookRuntime: HookRuntime | null = null

export function getHookRuntime(): HookRuntime {
  if (!defaultHookRuntime) {
    defaultHookRuntime = new HookRuntime()
  }
  return defaultHookRuntime
}

/**
 * Register default hooks from configuration.
 */
export function registerDefaultHooks(): void {
  const runtime = getHookRuntime()

  // Pre-tool-use: check permissions
  runtime.register({
    name: "permission-check",
    events: [HookEventName.PreToolUse],
    mode: HookExecutionMode.Blocking,
    timeoutMs: 5000,
    handler: async () => {
      // Check against permission rules
      // Additional permission check logic here
      return { shouldStop: false, additionalContext: [] }
    },
  })

  // Post-tool-use: record telemetry
  runtime.register({
    name: "telemetry-record",
    events: [HookEventName.PostToolUse],
    mode: HookExecutionMode.NonBlocking,
    timeoutMs: 2000,
    handler: async () => {
      // Record tool execution telemetry
      return { shouldStop: false, additionalContext: [] }
    },
  })

  // Session start: initialize state
  runtime.register({
    name: "session-init",
    events: [HookEventName.SessionStart],
    mode: HookExecutionMode.Blocking,
    timeoutMs: 5000,
    handler: async () => {
      // Initialize session state, load memories, etc.
      return { shouldStop: false, additionalContext: [] }
    },
  })
}
