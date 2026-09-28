/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type {
  AgentEvent,
  AgentEventSink,
  AgentMessage,
  AssistantMessage,
  ToolResultMessage,
} from "../../../../packages/protocol/src/index.js"
import { extractTextToolCalls } from "../../../../packages/provider/src/index.js"
import type { Provider } from "../../../../packages/provider/src/index.js"
import type { TrayambakConfig } from "../config.js"
import type { Tool, ToolContext } from "../tools/index.js"
import type { ToolResult } from "../../../../packages/protocol/src/index.js"
import type { Session } from "../session/session.js"
import type { DeveloperModeEngine } from "../developer-mode/index.js"
import { getRolloutBudget } from "../../../../packages/core/src/rollout_budget.js"
import {
  applyBudget,
  budgetStatus,
  estimateTokens,
  parseTokenBudget,
  resetBudget,
  shouldContinueTurn,
} from "../../../../packages/core/src/token_budget.js"
import { DEFAULT_PERMISSIONS, type PermissionConfig } from "../../../../packages/protocol/src/permissions.js"
import { evaluatePermission } from "../../../../packages/protocol/src/permission-rules.js"
import { compactMessages, policyFromConfig } from "../compaction.js"
import { readInbox } from "../tools/trayambak/send-message.js"
import { runPreToolUseHooks, runPostToolUseHooks, type HookShellExecutor } from "../tools/hook-exec.js"

/**
 * SKT AI LABS plan mode: the permission deny-list (only read-only tools survive
 * evaluation in the agent loop) plus this suffix, so the model explores the
 * workspace and proposes a plan instead of acting on it.
 */
const PLAN_MODE_INSTRUCTIONS =
  "PLAN MODE is active. All modifying tools are denied — you may only inspect the workspace with read-only tools. " +
  "Do NOT attempt to change anything. Produce a clear step-by-step implementation plan: goal, files to touch, " +
  "exact changes per file, verification steps, and open questions. " +
  "Finish by asking the user to approve the plan and switch out of plan mode to execute it."

export interface RunConfig {
  provider: Provider
  tools: Tool[]
  session: Session
  config: TrayambakConfig
  emit: AgentEventSink
  signal?: AbortSignal
  developerMode?: DeveloperModeEngine
  maxToolCalls?: number
  maxParallelToolCalls?: number
  sessionId?: string
  onRequestPermission?: (tool: string, args: unknown, reason: string) => Promise<boolean>
  /** Durable-inbox id this loop polls each turn (trayambak__SendMessage).
   *  Lets a running subagent actually RECEIVE messages and continue with
   *  context intact. Unset for foreground/main turns (no polling). */
  inboxId?: string
  /** Shell executor for config command hooks (Pre/PostToolUse). Defaults
   *  to the real executor; tests inject a stub (no processes spawned). */
  hookExecutor?: HookShellExecutor
}

async function chatWithRetry(run: RunConfig, request: Parameters<Provider["chat"]>[0]): ReturnType<Provider["chat"]> {
  const maxRetries = Math.max(0, run.config.maxRetries)
  const baseDelay = Math.max(100, run.config.retryDelayMs)
  let attempt = 0
  while (true) {
    try {
      return await run.provider.chat(request)
    } catch (error) {
      const raw: string = error instanceof Error ? error.message : String(error)
      const isRateLimit = /429|too many requests|rate.?limit/i.test(raw)
      const isTransient = /ECONNRESET|EPIPE|socket hang up|connection closed|ENOTFOUND|ETIMEDOUT|timeout/i.test(raw)
      const effectiveRetries = isRateLimit ? Math.max(maxRetries, 5) : maxRetries
      if (attempt >= effectiveRetries || run.signal?.aborted) {
        throw error
      }
      let delay: number
      if (isRateLimit) {
        const retryAfter = (error as unknown as { retryAfter?: string })?.retryAfter
        const parsedRetryAfter = retryAfter ? parseInt(retryAfter, 10) : NaN
        delay =
          !Number.isNaN(parsedRetryAfter) && parsedRetryAfter > 0
            ? Math.min(parsedRetryAfter * 1000, 30_000)
            : Math.min(baseDelay * Math.pow(2, attempt), 30_000)
      } else if (isTransient) {
        delay = Math.min(baseDelay * Math.pow(2, attempt), 30_000)
      } else {
        throw error
      }
      attempt++
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay)
        run.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer)
            reject(new Error("Operation aborted during provider retry."))
          },
          { once: true },
        )
      })
    }
  }
}

export async function runAgentLoop(prompt: string, run: RunConfig): Promise<AgentMessage[]> {
  // Rollout budget (AGENTS.md: budget awareness — never silently exhaust):
  // apply this run's configured budget ONCE on entry. The loop is the source
  // of truth for enforcement (the orchestrator file is not involved), so a
  // subagent run applies its own spec here too. An invalid spec already fell
  // back with a warning in loadConfig; if one reaches the loop anyway
  // (config bypassed sanitize), fall back to NO budget — never throw.
  if (run.config.budget) {
    const parsed = parseTokenBudget(run.config.budget)
    if (parsed.ok) applyBudget(parsed.budget)
    else resetBudget()
  }
  const userMessage: AgentMessage = { role: "user", content: prompt }
  run.session.add(userMessage)
  await run.emit({ type: "message_start", message: userMessage })

  let turns = 0
  const state = {
    toolCalls: 0,
    callTimes: [] as number[],
    distinctTools: new Set<string>(),
    recentCalls: [] as string[],
  }
  const seenInboxIds = new Set<string>()
  const maxToolCalls = run.maxToolCalls ?? run.config.maxToolCalls
  // Half-cut answers ("response stopped mid-list"): when the model exhausts
  // maxTokens mid-answer it stops with `length` and the turn would end on a
  // severed sentence. Auto-continue with a nudge turn instead, bounded so a
  // pathologically long answer still terminates.
  const MAX_LENGTH_CONTINUATIONS = 3
  let lengthContinuations = 0
  while (true) {
    if (++turns > run.config.maxTurns) {
      await run.emit({ type: "agent_end", messages: run.session.messages })
      return run.session.messages
    }
    if (run.signal?.aborted) {
      await run.emit({ type: "agent_end", messages: run.session.messages })
      return run.session.messages
    }
    // Budget check at the TOP of every turn: an exhausted budget ends the run
    // LOUDLY (budget_exhausted + agent_end + return) — AGENTS.md: "Budget
    // exhaustion stops the loop ... Never silently continue."
    if (!shouldContinueTurn(turns)) {
      const status = budgetStatus(turns)
      await run.emit({
        type: "budget_exhausted",
        used: status.used,
        max: status.max,
        // Infinity (unlimited token cap + turn budget) is not JSON-safe.
        remaining: Number.isFinite(status.remaining) ? status.remaining : 0,
      })
      await run.emit({ type: "agent_end", messages: run.session.messages })
      return run.session.messages
    }
    // Inbox delivery: a messageable subagent folds newly arrived inbox
    // messages in as user turns, so trayambak__SendMessage continues it
    // with context intact instead of appending to a file nobody reads.
    // Best-effort (never break a turn over inbox IO) and abort-aware.
    if (run.inboxId && !run.signal?.aborted) {
      try {
        for (const m of readInbox(run.inboxId)) {
          if (seenInboxIds.has(m.id)) continue
          seenInboxIds.add(m.id)
          run.session.add({ role: "user", content: "[message from " + m.from + "]: " + m.content })
        }
      } catch {
        /* inbox is best-effort */
      }
    }

    let assistant: AssistantMessage | null = null
    const MAX_EMPTY_RECOVER = 3
    let emptyRecoveries = 0
    for (;;) {
      assistant = await streamAssistant(run, prompt, () => {})
      if (!assistant) {
        break
      }
      const content = assistant.content
      const hasThinking = content.some((c) => c.type === "thinking")
      const hasText = content.some((c) => c.type === "text")
      const hasToolCalls = content.some((c) => c.type === "toolCall")
      const isEmpty = !hasThinking && !hasText && !hasToolCalls
      if (isEmpty && emptyRecoveries < MAX_EMPTY_RECOVER && !run.signal?.aborted) {
        emptyRecoveries++
        continue
      }
      break
    }
    if (!assistant) {
      break
    }
    // Every assistant response is charged against the rollout budget (the
    // numbers are ESTIMATED — see recordAssistantUsage). The next loop
    // iteration's top-of-turn check stops the run once they run out.
    recordAssistantUsage(run, assistant)

    const toolCalls = assistant.content.filter((c) => c.type === "toolCall")
    if (toolCalls.length === 0) {
      const textPart = assistant.content.find((c) => c.type === "text")
      if (textPart && "text" in textPart) {
        const { prose, toolCalls: extracted } = extractTextToolCalls(textPart.text)
        if (extracted.length > 0) {
          assistant.content = assistant.content.map((c) => (c.type === "text" ? { type: "text", text: prose } : c))
          for (const tc of extracted) assistant.content.push(tc)
          run.session.add(assistant)
          await run.emit({ type: "message_end", message: assistant })
          const results = await executeToolCalls(assistant, run, state, maxToolCalls)
          if (run.signal?.aborted) break
          void results
          continue
        }
      }
      run.session.add(assistant)
      await run.emit({ type: "message_end", message: assistant })
      if (assistant.stopReason === "length" && lengthContinuations < MAX_LENGTH_CONTINUATIONS && !run.signal?.aborted) {
        lengthContinuations++
        const nudge: AgentMessage = {
          role: "user",
          content: "Continue generating exactly where you stopped. Do not repeat what you already wrote.",
        }
        run.session.add(nudge)
        await run.emit({ type: "message_start", message: nudge })
        continue
      }
      break
    }

    run.session.add(assistant)
    await run.emit({ type: "message_end", message: assistant })
    await executeToolCalls(assistant, run, state, maxToolCalls)
    if (run.signal?.aborted) break
  }

  await run.emit({ type: "agent_end", messages: run.session.messages })

  if (
    run.developerMode &&
    (run.developerMode as DeveloperModeEngine).isEnabled() &&
    (run.developerMode as DeveloperModeEngine).config.stepByStep
  ) {
    await emitVerification(run)
  }

  return run.session.messages
}

/**
 * Charge one assistant response against the rollout budget.
 *
 * Usage numbers are ESTIMATES: the provider protocol carries no usage/token
 * fields anywhere (`Provider.chat` returns a bare `AssistantMessage`), so
 * both sides use the repo-wide `ceil(chars / 4)` convention — output = the
 * response's text/thinking/tool-argument chars, input = the wire messages
 * actually sent this turn. The budget's accounting weights `output_tokens`
 * (`samplingTokenWeight`), so the input estimate is reported only. Recording
 * is best-effort: budget bookkeeping must never break a turn.
 */
function recordAssistantUsage(run: RunConfig, assistant: AssistantMessage): void {
  try {
    const outputText = assistant.content
      .map((part) => (part.type === "toolCall" ? JSON.stringify(part.arguments ?? {}) : part.text))
      .join("\n")
    const inputText = JSON.stringify(run.session.toWireMessages())
    getRolloutBudget().recordUsage({
      input_tokens: estimateTokens(inputText),
      output_tokens: estimateTokens(outputText),
    })
  } catch {
    /* budget accounting is best-effort — never break a turn over it */
  }
}

async function streamAssistant(
  run: RunConfig,
  _prompt: string,
  onThinking?: (text: string) => void,
): Promise<AssistantMessage | null> {
  // Proactive compaction (SKT AI LABS preflight): keep the session inside the
  // model's usable context window before every model call.
  await ensureContextWithinLimit(run)
  const wire = run.session.toWireMessages()
  const system = wire.find((m) => m.role === "system")
  // Plan mode: deny-list permissions already hide mutating tools upstream;
  // this suffix steers the model into exploration + plan-writing.
  const rawSystem = system?.content ?? undefined
  const effectiveSystem =
    (run.config.permissions as PermissionConfig | undefined)?.uiMode === "plan" && rawSystem
      ? `${rawSystem}\n\n${PLAN_MODE_INSTRUCTIONS}`
      : rawSystem
  // Hide tools denied by permission rules from the model entirely (SKT AI LABS
  // behavior): a denied tool must not even be offered to the LLM.
  const effectiveDefs = (run.config.permissions as PermissionConfig | undefined) ?? DEFAULT_PERMISSIONS
  const toolDefs = run.tools
    .filter((t) => evaluatePermission(t.definition.name, undefined, effectiveDefs).action !== "deny")
    .map((t) => t.definition)

  let text = ""
  let thinking = ""
  let toolName: string | undefined
  const pendingEmits: Promise<void>[] = []
  const queueStreamEvent = (event: AgentEvent): void => {
    pendingEmits.push(
      Promise.resolve(run.emit(event)).catch(() => {
        /* never fail the stream on emit error */
      }),
    )
  }

  await run.emit({ type: "turn_start" })
  let assistant: AssistantMessage | null = null
  const MAX_EMPTY_RECOVER = 3
  let emptyRecoveries = 0
  const MAX_RECOVER = 3
  let recovered = 0
  // Outer-layer restarts for retryable failures. chatWithRetry already
  // bounded its own attempts (maxRetries + backoff) before rethrowing
  // here; the old unbounded `continue` restarted the whole call chain
  // forever on a persistently unreachable endpoint — an eternal
  // "Thinking…" spinner that never surfaced an error. Cap it so a dead
  // endpoint fails LOUDLY instead of spinning silently.
  const MAX_TRANSIENT_RESTARTS = 2
  let transientRestarts = 0

  for (;;) {
    text = ""
    thinking = ""
    toolName = undefined
    pendingEmits.length = 0

    try {
      assistant = await chatWithRetry(run, {
        system: effectiveSystem,
        messages: run.session.toWireMessages().filter((m) => m.role !== "system"),
        tools: run.config.nativeTools ? toolDefs : undefined,
        signal: run.signal,
        callbacks: {
          onText: (d) => {
            text += d
            queueStreamEvent({ type: "message_update", message: placeholder(text, thinking, []), delta: { text: d } })
          },
          onThinking: (d) => {
            thinking += d
            onThinking?.(thinking)
            queueStreamEvent({
              type: "message_update",
              message: placeholder(text, thinking, []),
              delta: { thinking: d },
            })
          },
          onToolCallDelta: (name, args) => {
            toolName = name
            queueStreamEvent({
              type: "message_update",
              message: placeholder(text, thinking, [{ id: "pending", name: toolName ?? "", args }]),
              delta: { toolCall: { type: "toolCall", id: "pending", name: toolName ?? "", arguments: {} } },
            })
          },
        },
      })
      await Promise.all(pendingEmits)
    } catch (err) {
      const raw: string = err instanceof Error ? err.message : String(err)
      // Node's happy-eyeballs connect failure (localhost → ::1 + 127.0.0.1)
      // surfaces as an AggregateError whose `.message` is EMPTY — the real
      // "connect ECONNREFUSED …" texts live in its nested `errors`. The old
      // `message.trim()` guard then dropped the emit entirely and the turn
      // died with NO row and NO log line: "type a message, press Enter,
      // nothing happens" (the reported send-dead bug). Recover the nested
      // cause (or the error code) so the failure is always loud AND useful.
      const nested: string =
        typeof err === "object" && err !== null && Array.isArray((err as { errors?: unknown[] }).errors)
          ? (err as { errors: unknown[] }).errors
              .map((e) => (e instanceof Error ? e.message : String(e)))
              .filter((m) => m.trim())
              .join("; ")
          : ""
      const errCode: string =
        typeof err === "object" && err !== null && "code" in err ? String((err as { code?: unknown }).code ?? "") : ""
      const isContextOverflow = /exceeds the available context|exceed_context_size|context size|too many tokens/i.test(
        raw,
      )
      if (isContextOverflow && recovered < MAX_RECOVER && run.session.messages.length > 1) {
        // Reactive overflow recovery: force every compaction stage (prune →
        // truncate → fold head into a marker) and retry once it fits.
        await ensureContextWithinLimit(run, { force: true })
        recovered++
        continue
      }
      const isRetryable =
        /429|too many requests|rate.?limit|ECONNRESET|EPIPE|socket hang up|connection closed|ENOTFOUND|ETIMEDOUT|timeout/i.test(
          raw,
        )
      if (isRetryable && !run.signal?.aborted && transientRestarts < MAX_TRANSIENT_RESTARTS) {
        transientRestarts++
        await new Promise((resolve) => setTimeout(resolve, 1000))
        continue
      }
      // ALWAYS surface the failure. The old `if (message.trim())` skipped
      // the emit entirely for an empty error message — the run then ended
      // with no row, no banner, nothing at all: "type a message, press
      // Enter, nothing happens" (the reported send-dead bug). A generic
      // fallback beats silence; the raw message is kept whenever present.
      const message: string = raw.trim() || nested.trim() || errCode.trim() || "unknown provider error"
      // 401s are always credentials, never the model: point at the fix
      // instead of leaving "Invalid username or password" as a dead end.
      const authHint = /401|invalid username or password|invalid api key|incorrect api key|authentication/i.test(
        message,
      )
        ? "\nKey rejected — run `/provider key` to re-check and fix the API key (it pings the real chat endpoint)."
        : ""
      await run.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `[model/connection error: ${message}]${authHint}` }],
          stopReason: "error",
        },
      })
      return null
    }

    if (!assistant) {
      break
    }
    const content = assistant.content
    const hasThinking = content.some((c) => c.type === "thinking")
    const hasText = content.some((c) => c.type === "text")
    const hasToolCalls = content.some((c) => c.type === "toolCall")
    const isEmpty = !hasThinking && !hasText && !hasToolCalls
    if (isEmpty && emptyRecoveries < MAX_EMPTY_RECOVER && !run.signal?.aborted) {
      emptyRecoveries++
      continue
    }
    break
  }
  if (!assistant) {
    return null
  }

  // Merge streamed deltas with the provider's assembled message to keep final text authoritative.
  const providerText = assistant.content.find((c) => c.type === "text")
  const finalText = text || (providerText && "text" in providerText ? providerText.text : "")
  const hasToolCalls = assistant.content.some((c) => c.type === "toolCall")
  const merged: AssistantMessage = {
    role: "assistant",
    stopReason: assistant.stopReason,
    content: [
      ...(thinking ? [{ type: "thinking" as const, text: thinking }] : []),
      ...(finalText
        ? [{ type: "text" as const, text: finalText }]
        : // Tool-call-only responses are the NORM, not an error: injecting the
          // "no content" filler here painted a bogus assistant row after every
          // tool batch (and persisted it to the session log + model context).
          // Only a genuinely contentless reply earns the retry hint.
          hasToolCalls
          ? []
          : [{ type: "text" as const, text: "The model returned no content. Please try again." }]),
      ...assistant.content.filter((c) => c.type === "toolCall"),
    ],
  }
  await run.emit({ type: "message_start", message: merged })
  return merged
}

async function executeToolCalls(
  assistant: AssistantMessage,
  run: RunConfig,
  state: { toolCalls: number; callTimes: number[]; distinctTools: Set<string>; recentCalls: string[] },
  maxToolCalls: number,
): Promise<ToolResultMessage[]> {
  const calls = assistant.content.filter((c) => c.type === "toolCall")
  const hasSequential = calls.some((c) => {
    if (c.type !== "toolCall") return false
    const tool = run.tools.find((t) => t.definition.name === c.name)
    return tool?.definition.executionMode === "sequential"
  })

  const results: ToolResultMessage[] = []
  if (hasSequential) {
    for (const call of calls) {
      const r = await runOneTool(call, run, state, maxToolCalls)
      if (r) results.push(r)
      if (run.signal?.aborted) break
    }
  } else {
    const rawLimit = run.maxParallelToolCalls ?? run.config.maxParallelToolCalls
    // NaN/undefined limit would silently skip every call (i += NaN never
    // advances) — fall back to serial instead of dropping work.
    const limit = Math.max(1, Number.isFinite(rawLimit) ? (rawLimit as number) : 1)
    for (let i = 0; i < calls.length; i += limit) {
      const batch = await Promise.all(calls.slice(i, i + limit).map((c) => runOneTool(c, run, state, maxToolCalls)))
      for (const r of batch) if (r) results.push(r)
    }
  }

  for (const r of results) {
    run.session.add(r)
  }
  await run.emit({ type: "turn_end", message: assistant, toolResults: results })
  return results
}

async function runOneTool(
  call: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
  run: RunConfig,
  state: { toolCalls: number; callTimes: number[]; distinctTools: Set<string>; recentCalls: string[] },
  maxToolCalls: number,
): Promise<ToolResultMessage | null> {
  if (call.type !== "toolCall") return null
  const signature = toolCallSignature(call)
  state.recentCalls.push(signature)
  if (state.recentCalls.length > 16) state.recentCalls = state.recentCalls.slice(-16)
  const loopDetected = detectDoomLoop(state.recentCalls)
  if (loopDetected) {
    const permissionId = `${call.id}-doomloop`
    await run.emit({
      type: "permission_request",
      id: permissionId,
      tool: "doom_loop",
      args: call.arguments,
      reason: `Trayambak detected a repeating tool call loop for ${call.name}. Approval required to continue.`,
    })
    let approved = false
    if (run.onRequestPermission) {
      try {
        approved = await run.onRequestPermission("doom_loop", call.arguments, `Approve repeated ${call.name} calls?`)
      } catch {
        approved = false
      }
    }
    await run.emit({ type: "permission_response", id: permissionId, allowed: approved })
    if (!approved) {
      const denied: ToolResult = {
        content: [{ type: "text", text: `Trayambak blocked a repeating tool-call loop for ${call.name}.` }],
        isError: true,
      }
      await run.emit({
        type: "tool_execution_end",
        toolCallId: call.id,
        toolName: call.name,
        result: denied,
        isError: true,
      })
      return { role: "tool", toolCallId: call.id, toolName: call.name, content: denied.content, isError: true }
    }
  }
  if (state.toolCalls >= maxToolCalls) {
    await run.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments })
    const msg = `Tool-call limit reached (${maxToolCalls} per prompt). Skipping '${call.name}' and stopping.`
    await run.emit({
      type: "tool_execution_end",
      toolCallId: call.id,
      toolName: call.name,
      result: { content: [{ type: "text", text: msg }], isError: true },
      isError: true,
    })
    if (run.developerMode?.isEnabled() && run.developerMode.config.observeMistakes) {
      run.developerMode.recordMistake({
        type: "tool_error",
        description: `Tool-call limit reached (${maxToolCalls} per prompt)`,
        severity: 3,
        context: { toolName: call.name, maxToolCalls },
      })
    }
    return {
      role: "tool",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: msg }],
      isError: true,
    }
  }
  const maxDistinct = run.config.maxDistinctToolCalls ?? 1000
  if (state.distinctTools.size >= maxDistinct && !state.distinctTools.has(call.name)) {
    await run.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments })
    const msg = `Distinct tool limit reached (${maxDistinct} per session). Skipping '${call.name}'.`
    await run.emit({
      type: "tool_execution_end",
      toolCallId: call.id,
      toolName: call.name,
      result: { content: [{ type: "text", text: msg }], isError: true },
      isError: true,
    })
    if (run.developerMode?.isEnabled() && run.developerMode.config.observeMistakes) {
      run.developerMode.recordMistake({
        type: "tool_error",
        description: `Distinct tool limit reached (${maxDistinct} per session)`,
        severity: 3,
        context: { toolName: call.name, maxDistinctToolCalls: maxDistinct },
      })
    }
    return {
      role: "tool",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: msg }],
      isError: true,
    }
  }
  state.distinctTools.add(call.name)
  await respectRate(run.config, state, run.signal)
  state.toolCalls++
  state.callTimes.push(Date.now())
  await run.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments })

  const initialText = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {})
  await run.emit({
    type: "tool_execution_update",
    toolCallId: call.id,
    toolName: call.name,
    partialResult: { content: [{ type: "text", text: initialText }], isError: false },
  })

  const effectivePermissions: PermissionConfig =
    (run.config.permissions as PermissionConfig | undefined) ?? DEFAULT_PERMISSIONS
  // PreToolUse command hooks (config.hooks.preToolUse): user scripts that
  // can block (deny/stop), request approval (ask), or inject context.
  // Denials land as tool errors so the model sees and adapts to them.
  let hookContext: string[] = []
  try {
    const verdict = await runPreToolUseHooks(
      run.config,
      { toolName: call.name, args: call.arguments, cwd: run.config.cwd, signal: run.signal, sessionId: run.sessionId },
      run.hookExecutor,
    )
    hookContext = verdict.additionalContext
    if (verdict.decision === "deny" || verdict.stop) {
      const why = verdict.reason ?? verdict.stopReason ?? `hook denied ${call.name}`
      const denied: ToolResult = {
        content: [{ type: "text", text: `Hook blocked ${call.name}: ${why}` }],
        isError: true,
      }
      await run.emit({
        type: "tool_execution_end",
        toolCallId: call.id,
        toolName: call.name,
        result: denied,
        isError: true,
      })
      return { role: "tool", toolCallId: call.id, toolName: call.name, content: denied.content, isError: true }
    }
    if (verdict.decision === "ask") {
      const permissionId = `${call.id}-hookask`
      await run.emit({
        type: "permission_request",
        id: permissionId,
        tool: call.name,
        args: call.arguments,
        reason: verdict.reason ?? `Hook requested confirmation for ${call.name}`,
      })
      let approved = false
      if (run.onRequestPermission) {
        try {
          approved = await run.onRequestPermission(call.name, call.arguments, verdict.reason ?? `Approve ${call.name}?`)
        } catch {
          approved = false
        }
      }
      await run.emit({ type: "permission_response", id: permissionId, allowed: approved })
      if (!approved) {
        const denied: ToolResult = {
          content: [{ type: "text", text: `Hook-gated ${call.name} was not approved.` }],
          isError: true,
        }
        await run.emit({
          type: "tool_execution_end",
          toolCallId: call.id,
          toolName: call.name,
          result: denied,
          isError: true,
        })
        return { role: "tool", toolCallId: call.id, toolName: call.name, content: denied.content, isError: true }
      }
    }
  } catch {
    /* hook infra failures never break the turn */
  }
  const decision = evaluatePermission(call.name, call.arguments, effectivePermissions)
  if (decision.action === "deny") {
    const why = decision.rule
      ? `denied by rule [${decision.layer ?? "default"}]: ${decision.rule.tool} ${decision.rule.pattern ? `→ ${decision.rule.pattern}` : ""}`
      : decision.source === "read-only-mode"
        ? "permission mode is read-only"
        : "denied by permission rules"
    const denied: ToolResult = {
      content: [
        {
          type: "text",
          text: `Trayambak permission denied for ${call.name}: ${why}. This tool is hidden/blocked under the current permission ruleset.`,
        },
      ],
      isError: true,
    }
    await run.emit({
      type: "tool_execution_end",
      toolCallId: call.id,
      toolName: call.name,
      result: denied,
      isError: true,
    })
    return { role: "tool", toolCallId: call.id, toolName: call.name, content: denied.content, isError: true }
  }
  const needsApproval = decision.action === "ask"
  if (needsApproval) {
    const permissionId = `${call.id}-perm`
    await run.emit({
      type: "permission_request",
      id: permissionId,
      tool: call.name,
      args: call.arguments,
      reason:
        decision.source === "force-ask"
          ? `Sensitive operation (${decision.rule?.reason ?? "force-ask rule"}) — approval required for ${call.name}`
          : `Trayambak approval required for ${call.name}`,
      forceAsk: decision.source === "force-ask",
    })
    let approved = true
    if (run.onRequestPermission) {
      try {
        approved = await run.onRequestPermission(call.name, call.arguments, `Approve ${call.name}?`)
      } catch {
        approved = false
      }
    } else {
      approved = false
    }
    await run.emit({ type: "permission_response", id: permissionId, allowed: approved })
    if (!approved) {
      const denied: ToolResult = {
        content: [{ type: "text", text: `Trayambak permission denied for ${call.name}. Tool execution blocked.` }],
        isError: true,
      }
      await run.emit({
        type: "tool_execution_end",
        toolCallId: call.id,
        toolName: call.name,
        result: denied,
        isError: true,
      })
      return { role: "tool", toolCallId: call.id, toolName: call.name, content: denied.content, isError: true }
    }
  }
  const tool = run.tools.find((t) => t.definition.name === call.name)
  const context: ToolContext = {
    cwd: run.config.cwd,
    config: run.config,
    permissions: effectivePermissions,
    sessionId: run.sessionId,
    requestPermission: run.onRequestPermission
      ? async (toolName, command, reason) => {
          const pid = `${call.id}-perm-${toolName}`
          await run.emit({ type: "permission_request", id: pid, tool: toolName, args: { command }, reason })
          const ok = await run.onRequestPermission!(toolName, { command }, reason)
          await run.emit({ type: "permission_response", id: pid, allowed: ok })
          return ok
        }
      : undefined,
  }
  let result: ToolResult
  if (!tool) {
    result = { content: [{ type: "text", text: `Unknown tool: ${call.name}` }], isError: true }
    if (run.developerMode?.isEnabled() && run.developerMode.config.observeMistakes) {
      run.developerMode.recordMistake({
        type: "wrong_tool",
        description: `Unknown tool called: ${call.name}`,
        severity: 2,
        context: { toolName: call.name },
      })
    }
  } else {
    try {
      result = await withTimeout(
        tool.execute(call.id, call.arguments as Record<string, unknown>, run.signal, undefined, context),
        run.config.timeoutMs,
        call.name,
      )
    } catch (err) {
      result = {
        content: [{ type: "text", text: `Tool error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      }
      if (run.developerMode?.isEnabled() && run.developerMode.config.observeMistakes) {
        run.developerMode.recordMistake({
          type: "tool_error",
          description: `Tool execution failed: ${call.name} - ${err instanceof Error ? err.message : String(err)}`,
          severity: 3,
          context: { toolName: call.name, error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
  }

  await run.emit({
    type: "tool_execution_end",
    toolCallId: call.id,
    toolName: call.name,
    result,
    isError: result.isError,
  })

  // PostToolUse hooks: context-only, never block. Their output rides along
  // so the model sees hook guidance next turn.
  try {
    const post = await runPostToolUseHooks(
      run.config,
      { toolName: call.name, args: call.arguments, cwd: run.config.cwd, signal: run.signal, sessionId: run.sessionId },
      run.hookExecutor,
    )
    const extra = [...hookContext, ...post].filter((s) => s.trim().length > 0)
    if (extra.length > 0) {
      result = {
        ...result,
        content: [...result.content, { type: "text", text: extra.join("\n") }],
      }
    }
  } catch {
    /* post-hooks never break the turn */
  }

  return {
    role: "tool",
    toolCallId: call.id,
    toolName: call.name,
    content: result.content,
    isError: result.isError,
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Tool timed out: ${label} (${timeoutMs}ms)`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

/** Rate limit: keep only the last 1s of calls; if the window is full, wait. */
async function respectRate(
  config: RunConfig["config"],
  state: { callTimes: number[] },
  signal?: AbortSignal,
): Promise<void> {
  if (config.toolCallRate <= 0) return
  // Sparse configs (tests, embeddings) may omit the rate: NaN comparisons
  // below would spin the wait loop forever instead of running the tool.
  if (!(config.toolCallRate > 0)) return
  for (;;) {
    if (signal?.aborted) return
    const now = Date.now()
    while (state.callTimes.length > 0 && now - state.callTimes[0] >= 1000) state.callTimes.shift()
    if (state.callTimes.length < config.toolCallRate) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 120)
      signal?.addEventListener("abort", () => clearTimeout(timer), { once: true })
    })
  }
}

function placeholder(
  text: string,
  thinking: string,
  toolCalls: { id: string; name: string; args: string }[],
): AssistantMessage {
  const content: AssistantMessage["content"] = []
  if (thinking) content.push({ type: "thinking", text: thinking })
  if (text) content.push({ type: "text", text })
  for (const tc of toolCalls) {
    content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: { __partial: tc.args } })
  }
  return { role: "assistant", content, stopReason: "tool_use" }
}

function toolCallSignature(call: Extract<AssistantMessage["content"][number], { type: "toolCall" }>): string {
  const args = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {})
  return `${call.name}:${args}`
}

/** Returns true when the last 3 tool calls are identical (doom loop). */
function detectDoomLoop(recentCalls: string[]): boolean {
  if (recentCalls.length < 3) return false
  const lastThree = recentCalls.slice(-3)
  return lastThree[0] === lastThree[1] && lastThree[1] === lastThree[2]
}

/**
 * Keep the session inside the model's usable context window.
 * Non-forced: only runs once the estimate crosses the trigger ratio.
 * Forced: runs every stage regardless (reactive overflow / manual /compact).
 * Returns true when the session was rewritten (a `compaction` event is
 * emitted in that case so the UI can show what was freed).
 */
async function ensureContextWithinLimit(run: RunConfig, opts?: { force?: boolean }): Promise<boolean> {
  const result = compactMessages(run.session.messages, policyFromConfig(run.config), {
    force: opts?.force ?? false,
    systemPrompt: run.session.systemContext,
  })
  if (!result.changed) return false
  run.session.clear()
  for (const m of result.messages) run.session.add(m)
  await run.emit({
    type: "compaction",
    removedMessages: result.removedMessages,
    prunedToolOutputs: result.prunedToolOutputs,
    freedTokens: result.freedTokens,
    estimatedBefore: result.estimatedBefore,
    estimatedAfter: result.estimatedAfter,
  })
  return true
}

async function emitVerification(run: RunConfig): Promise<void> {
  await run.emit({ type: "verification_start" })
  const steps: Array<{ name: string; status: "pass" | "fail" | "skip"; detail?: string; duration?: number }> = []
  const toolErrors = run.session.messages.filter((m) => m.role === "tool" && m.isError).length
  const toolCalls = run.session.messages
    .filter((m) => m.role === "assistant")
    .reduce((sum, m) => sum + m.content.filter((c) => c.type === "toolCall").length, 0)

  steps.push({ name: "lint", status: "skip", detail: "no linter configured" })
  steps.push({ name: "typecheck", status: "skip", detail: "no typecheck script configured" })
  steps.push({ name: "test", status: "skip", detail: "no test script configured" })
  steps.push({
    name: "build",
    status: toolErrors === 0 ? "pass" : "fail",
    detail: toolErrors === 0 ? "no tool errors" : `${toolErrors} tool error(s)`,
    duration: 0,
  })
  steps.push({
    name: "consistency",
    status: toolCalls > 0 ? "pass" : "skip",
    detail: `${toolCalls} tool call(s) executed`,
  })

  for (const step of steps) {
    await run.emit({
      type: "verification_step",
      name: step.name,
      status: step.status,
      detail: step.detail,
      duration: step.duration,
    })
  }

  const passed = steps.every((s) => s.status !== "fail")
  await run.emit({ type: "verification_end", passed, steps })
  await run.emit({ type: "ready_for_verification", path: run.config.cwd })
}
