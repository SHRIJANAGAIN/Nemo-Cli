/*
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
import type { NemoConfig } from "../config.js"
import type { Tool, ToolContext } from "../tools/index.js"
import type { ToolResult } from "../../../../packages/protocol/src/index.js"
import { toolResultImages } from "../../../../packages/protocol/src/index.js"
import { isLengthStop } from "../../../../packages/protocol/src/index.js"
import { isNetworkOutage, waitForNetwork } from "./network-recovery.js"
import { stripHistoricalMedia } from "../../../../packages/core/src/media-strip.js"
import { publishActivity } from "../../../../packages/core/src/terminal-activity.js"
import type { Session } from "../session/session.js"
import type { DeveloperModeEngine } from "../developer-mode/index.js"
import { recordModelUsage } from "./usage-accounting.js"
import {
  applyBudget,
  budgetStatus,
  parseTokenBudget,
  resetBudget,
  shouldContinueTurn,
} from "../../../../packages/core/src/token_budget.js"
import { DEFAULT_PERMISSIONS, type PermissionConfig } from "../../../../packages/protocol/src/permissions.js"
import { evaluatePermission } from "../../../../packages/protocol/src/permission-rules.js"
import { approvalFor, DenialTracker } from "../../../../packages/core/src/approval.js"
import { redactPayload } from "../../../../packages/core/src/secrets.js"
import { annotateUntrustedToolResult, guardPrompt, type RefusalKind } from "./prompt-guard.js"
import { compactMessages, policyFromConfig } from "../compaction.js"
import { agenticCompact, shouldUseAgenticCompaction, type AgenticCompactionResult } from "../compaction-agentic.js"
import { readInbox } from "../tools/nemo/send-message.js"
import { runPreToolUseHooks, runPostToolUseHooks, type HookShellExecutor } from "../tools/hook-exec.js"
import { withRetry } from "../../../../packages/core/src/retry.js"
import {
  classifyProviderError,
  isContextOverflowError,
  providerErrorHint,
} from "../../../../packages/core/src/provider_errors.js"

/**
 * Shrijan plan mode: the permission deny-list (only read-only tools survive
 * evaluation in the agent loop) plus this suffix, so the model explores the
 * workspace and proposes a plan instead of acting on it.
 */
const PLAN_MODE_INSTRUCTIONS =
  "PLAN MODE is active. All modifying tools are denied — you may only inspect the workspace with read-only tools. " +
  "Do NOT attempt to change anything. Produce a clear step-by-step implementation plan: goal, files to touch, " +
  "exact changes per file, verification steps, and open questions. " +
  "Finish by asking the user to approve the plan and switch out of plan mode to execute it."

/**
 * Streamed `text`/`thinking` buffers are memory-bounded (round 13): every
 * delta ALSO allocates a full placeholder message, so an endless or
 * multi-megabyte stream was quadratic churn with no ceiling. 2M chars sits
 * far above any real context window — truncating the FINAL message is the
 * context manager's job, this only stops mid-stream buffers from growing
 * forever. The provider's returned assistant message is untouched.
 */
export const MAX_STREAM_TEXT_CHARS = 2_000_000
export const MAX_STREAM_THINKING_CHARS = 2_000_000

/**
 * Append-at-most-`max` helper: returns the slice of `delta` that still
 * fits (null = the buffer is already full, drop the delta entirely).
 * Exported for the guards test that pins the ceiling.
 */
export function boundedAppend(buffer: string, delta: string, max: number): string | null {
  const room = max - buffer.length
  if (room <= 0) return null
  return delta.length > room ? delta.slice(0, room) : delta
}

export interface RunConfig {
  provider: Provider
  tools: Tool[]
  session: Session
  config: NemoConfig
  emit: AgentEventSink
  signal?: AbortSignal
  developerMode?: DeveloperModeEngine
  maxToolCalls?: number
  maxParallelToolCalls?: number
  sessionId?: string
  onRequestPermission?: (tool: string, args: unknown, reason: string) => Promise<boolean>
  /** Durable-inbox id this loop polls each turn (nemo__SendMessage).
   *  Lets a running subagent actually RECEIVE messages and continue with
   *  context intact. Unset for foreground/main turns (no polling). */
  inboxId?: string
  /** Shell executor for config command hooks (Pre/PostToolUse). Defaults
   *  to the real executor; tests inject a stub (no processes spawned). */
  hookExecutor?: HookShellExecutor
  /** Denial tracker for the approval ladder (approvalFor). Created per
   *  loop when absent, so denial counts survive across turns in a run. */
  approvalTracker?: DenialTracker
  /** Audit sink for the tool gate (recordAudit). Opt-in: when absent the
   *  loop runs with no durable audit (tests, embeddings). Production
   *  (Agent.run) passes getDatabase(); the gate never awaits it and never
   *  throws through it. Structural type so tests inject a fake without
   *  importing the state store. */
  audit?: { recordAudit(action: string, actor: string, target: string, result: string): void }
}

/**
 * Provider chat with retry.
 *
 * Now delegated to `withRetry` in packages/core. The inline version this
 * replaced had three defects that the shared module does not:
 *
 *  1. **Abort-listener leak.** It added an `abort` listener per retry sleep and
 *     never removed it on the success path. A session that retried even a few
 *     times accumulated one listener per attempt on the SAME AbortSignal, so the
 *     warning threshold was crossed and every later abort walked a growing list.
 *  2. **A false-positive transient match.** `\b5\d{2}\b` matched the three digits
 *     "500" ANYWHERE in the message — including a model name, a token count, or a
 *     quoted user prompt. "model qwen-500 failed: bad key" was therefore
 *     classified transient and retried five times before surfacing a fatal error
 *     the user needed to see.
 *  3. **No jitter.** Every client backed off in lockstep, so the retry storm
 *     amplified exactly the load spike that caused the outage.
 *
 * Retry-After is now honoured as a NUMBER (the old code typed it as a string and
 * `parseInt`'d a number), and the magic "rate limits get at least 5 attempts"
 * floor is gone — it was never documented and never configurable.
 */
async function chatWithRetry(run: RunConfig, request: Parameters<Provider["chat"]>[0]): ReturnType<Provider["chat"]> {
  const maxRetries = Math.max(0, run.config.maxRetries)
  const baseDelay = Math.max(100, run.config.retryDelayMs)

  const outcome = await withRetry(
    async () => run.provider.chat(request),
    {
      // `maxRetries` counts RETRIES in config; withRetry counts ATTEMPTS.
      maxAttempts: maxRetries + 1,
      baseDelayMs: baseDelay,
      maxDelayMs: 30_000,
      jitterRatio: 0.25,
    },
    run.signal,
  )

  if (outcome.ok) return outcome.value as ReturnType<Provider["chat"]> extends Promise<infer T> ? T : never
  // Rethrow the ORIGINAL error so the caller's error path (audit, transcript,
  // aggregate-error recovery) sees exactly what the provider said.
  throw outcome.error ?? new Error("provider chat failed")
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
  // Deterministic prompt guard, BEFORE any model call. Extraction asks
  // ("repeat system instructions…"), credential-value asks ("print exact
  // NEMO_API_KEY") and pure instruction-override prompts are answered
  // here with zero provider invocations: a refusal the model never sees
  // cannot be jailbroken out of it, and there is no 180s timeout to burn.
  // Override-tainted prompts are neutralized (directive stripped, hierarchy
  // reminder appended) instead of refused, so the legitimate remainder of
  // the request still runs.
  const verdict = guardPrompt(prompt)
  const userMessage: AgentMessage = {
    role: "user",
    content: verdict.action === "allow" ? verdict.prompt : prompt,
  }
  run.session.add(userMessage)
  await run.emit({ type: "message_start", message: userMessage })
  if (verdict.action === "refuse") {
    recordPromptGuardAudit(run, verdict.kind, "refused")
    const refusal: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: verdict.reply }],
      stopReason: "end_turn",
    }
    run.session.add(refusal)
    await run.emit({ type: "message_end", message: refusal })
    await run.emit({ type: "agent_end", messages: run.session.messages })
    return run.session.messages
  }
  if (verdict.neutralized) recordPromptGuardAudit(run, "instruction-override", "neutralized")

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
  // pathologically long answer still terminates. Configurable via
  // maxLengthContinuations (default 10, 0 = disabled).
  const MAX_LENGTH_CONTINUATIONS = run.config.maxLengthContinuations ?? 10
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
    // messages in as user turns, so nemo__SendMessage continues it
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
    // #122 — replay instead of settling a severed turn. A stream that dies
    // mid-answer still carries the text it managed to emit, so the loop used
    // to accept that fragment as a finished reply (the "response gets cut"
    // report). Re-running costs one model call and, because streamAssistant's
    // text/thinking buffers are local to it, each attempt starts clean — the
    // fragment is DISCARDED rather than appended to. Bounded so a provider
    // that is permanently incomplete still terminates.
    const MAX_INCOMPLETE_REPLAYS = 2
    let incompleteReplays = 0
    for (;;) {
      // Terminal activity (OSC 777) — the shell tab can then say what the turn
      // is actually doing instead of a title that only knows "busy"/"not busy".
      // A no-op unless NEMO_TERMINAL_ACTIVITY=1, so pipes stay clean.
      publishActivity("busy")
      assistant = await streamAssistant(run, prompt, () => {})
      publishActivity(assistant ? "done" : "error")
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
      if (isIncompleteReply(assistant) && incompleteReplays < MAX_INCOMPLETE_REPLAYS && !run.signal?.aborted) {
        incompleteReplays++
        publishActivity("retry")
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
      // The continuation budget is per ANSWER, not per run. It used to be a
      // lifetime counter that was only ever incremented, so three long answers
      // anywhere in a session silently truncated every answer after them —
      // which is what made this look intermittent: the first replies were fine
      // and later ones cut off mid-sentence. A turn that finished on its own
      // terms restores the budget.
      if (!isLengthStop(assistant.stopReason)) lengthContinuations = 0
      if (
        isLengthStop(assistant.stopReason) &&
        lengthContinuations < MAX_LENGTH_CONTINUATIONS &&
        !run.signal?.aborted
      ) {
        lengthContinuations++
        const nudge: AgentMessage = {
          role: "user",
          // Internal nudge — hidden from UI, tells model to continue from cutoff
          content:
            "[internal:nudge] Continue generating exactly where you stopped. Do not repeat what you already wrote.",
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
 * actually sent this turn. Recording is best-effort: budget bookkeeping must
 * never break a turn.
 *
 * BOTH sides are charged (#64): the core accounting weights `output_tokens`
 * only, which made a token cap blind to the denial-loop burn — each retry
 * turn re-pays the whole (growing) context as input while emitting a tiny
 * output, so the loop could run away to maxTurns with the budget silent.
 * `codex_rollout_budget_units` is the sanctioned caller-side override
 * (DEFAULT_ROLLOUT_BUDGET.samplingTokenWeight = 1 ⇒ 1 estimated token = 1
 * unit on both sides); the protected packages/core accounting is untouched.
 */
function recordAssistantUsage(run: RunConfig, assistant: AssistantMessage): void {
  const outputText = assistant.content
    .map((part) => (part.type === "toolCall" ? JSON.stringify(part.arguments ?? {}) : part.text))
    .join("\n")
  recordModelUsage(JSON.stringify(run.session.toWireMessages()), outputText)
}

async function streamAssistant(
  run: RunConfig,
  _prompt: string,
  onThinking?: (text: string) => void,
): Promise<AssistantMessage | null> {
  // Proactive compaction (Shrijan preflight): keep the session inside the
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
  // Hide tools denied by permission rules from the model entirely (Shrijan
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
  // here; the old budget (2 restarts × fixed 1s) gave up after ~10s, so a
  // connection blip barely longer than that killed the whole run with a
  // "[model/connection error]" row ("STOP HO JATA ERROR SE" — Codex keeps
  // working until the work is done). Ride out longer blips: more restarts
  // with exponential backoff, still bounded by count AND wall-clock so a
  // dead endpoint fails LOUDLY instead of spinning silently forever.
  const MAX_TRANSIENT_RESTARTS = 5
  const TRANSIENT_RESTART_BUDGET_MS = 120_000
  const TRANSIENT_RESTART_MAX_MS = 15_000
  let transientRestarts = 0
  let firstTransientAt = 0

  for (;;) {
    text = ""
    thinking = ""
    toolName = undefined
    pendingEmits.length = 0

    try {
      assistant = await chatWithRetry(run, {
        system: effectiveSystem,
        messages: stripHistoricalMedia(run.session.toWireMessages().filter((m) => m.role !== "system")),
        tools: run.config.nativeTools ? toolDefs : undefined,
        signal: run.signal,
        callbacks: {
          onText: (d) => {
            const slice = boundedAppend(text, d, MAX_STREAM_TEXT_CHARS)
            if (slice === null) return
            text += slice
            queueStreamEvent({
              type: "message_update",
              message: placeholder(text, thinking, []),
              delta: { text: slice },
            })
          },
          onThinking: (d) => {
            const slice = boundedAppend(thinking, d, MAX_STREAM_THINKING_CHARS)
            if (slice === null) return
            thinking += slice
            onThinking?.(thinking)
            queueStreamEvent({
              type: "message_update",
              message: placeholder(text, thinking, []),
              delta: { thinking: slice },
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
      //
      // That flattening, and the three inline regexes that used to sit here
      // (context-overflow / retryable / auth-hint), now live in
      // `packages/core/src/provider_errors.ts`. They are duplicated there no
      // longer — and the duplication was not harmless: the outer restart copy
      // still carried the `\b5\d{2}\b` false-positive that `chatWithRetry`'s own
      // docstring says was removed, so a session pointed at `qwen-500` retried
      // a fatal bad-key error five times before surfacing it.
      const info = classifyProviderError({ error: err })
      const nested: string = info.message === raw ? "" : info.message
      const errCode: string = info.code ?? ""
      if (isContextOverflowError(info) && recovered < MAX_RECOVER && run.session.messages.length > 1) {
        // Reactive overflow recovery: force every compaction stage (prune →
        // truncate → fold head into a marker) and retry once it fits.
        await ensureContextWithinLimit(run, { force: true })
        recovered++
        continue
      }
      const isRetryable = info.retryable
      // #124 — a LOCAL network outage is not a server problem. The retry budget
      // below is sized for a gateway blip (5 tries / 120s); a refused socket
      // means nothing is answering until the interface comes back, so counting
      // down that budget kills a run whose network recovered seconds later.
      // Park the turn and probe the provider endpoint instead, and say so out
      // loud rather than appearing to hang.
      if (!run.signal?.aborted && isNetworkOutage(`${raw} ${nested} ${errCode}`)) {
        const probeTarget = providerProbeUrl(run)
        // Nothing to probe → the bounded retry path below is the honest
        // fallback rather than an indefinite wait.
        if (probeTarget.length > 0) {
          const outageStart = Date.now()
          queueStreamEvent({ type: "message_update", message: placeholder(text, thinking, []), delta: { text: "" } })
          await run.emit({
            type: "network_lost",
            message: "Network connection lost — waiting for it to come back.",
          })
          const outcome = await waitForNetwork({
            probeUrl: probeTarget,
            signal: run.signal,
            onState: (state) => {
              if (state === "timeout" || state === "aborted") return
              void run.emit({
                type: "network_restored",
                waitedMs: Date.now() - outageStart,
                message: "Network is back — resuming.",
              })
            },
          })
          if (outcome === "restored") {
            // The interface is back: reset the transient accounting so the
            // restart budget is available again, and retry the SAME turn.
            transientRestarts = 0
            firstTransientAt = 0
            continue
          }
          if (outcome === "aborted") break
          // timeout → fall through and report the failure loudly as before.
        }
      }
      const transientBudgetSpent =
        firstTransientAt !== 0 && Date.now() - firstTransientAt >= TRANSIENT_RESTART_BUDGET_MS
      if (isRetryable && !run.signal?.aborted && transientRestarts < MAX_TRANSIENT_RESTARTS && !transientBudgetSpent) {
        if (firstTransientAt === 0) firstTransientAt = Date.now()
        // Backoff off the configured retry base (production 750ms →
        // 0.75/1.5/3/6/12s ≈ 23s of patience; tests pin a tiny base).
        // Abort-aware: a 15s nap must never outlive a Ctrl+C.
        const delay = Math.min(
          Math.max(0, run.config.retryDelayMs) * Math.pow(2, transientRestarts),
          TRANSIENT_RESTART_MAX_MS,
        )
        transientRestarts++
        // Abort-aware by RESOLVING early, not by rejecting.
        //
        // This await sits inside the `catch` that handled the provider failure, so
        // a rejection thrown from here propagates out of the whole try/catch —
        // there is no enclosing handler, and it surfaced as an unhandled
        // rejection rather than a transcript row. Resolving lets the loop's next
        // `if (run.signal?.aborted)` guard produce the proper `[model/connection
        // error: Operation aborted during provider retry.]` message the tests pin.
        //
        // The listener is also removed on the normal path. `once: true` only
        // detaches when the signal FIRES, so a successful sleep left a listener
        // behind on the same signal for the rest of the session — one per retry,
        // until the warning threshold was crossed.
        await new Promise<void>((resolve) => {
          if (run.signal?.aborted === true) {
            resolve()
            return
          }
          const onAbort = (): void => {
            clearTimeout(timer)
            resolve()
          }
          const timer = setTimeout(() => {
            run.signal?.removeEventListener("abort", onAbort)
            resolve()
          }, delay)
          run.signal?.addEventListener("abort", onAbort, { once: true })
        })
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
      // The hint now comes from the classifier, so the transcript row, the
      // audit log and the TUI banner cannot disagree about what to say.
      const authHint = providerErrorHint(info) ?? ""
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

  // Merge streamed deltas with the provider's assembled message.
  //
  // Streamed deltas win while the stream is INTACT: they are what the user
  // watched render, and several providers return a placeholder text part that
  // would otherwise overwrite the real answer. But a stream that reached
  // MAX_STREAM_TEXT_CHARS was truncated — its buffer is a prefix of the reply,
  // not the reply. Trusting it there made every capped turn end with 2M
  // characters of truncated deltas and the model's actual answer discarded, so
  // a truncated stream falls back to the provider's assembled text.
  const providerText = assistant.content.find((c) => c.type === "text")
  const assembled = providerText && "text" in providerText ? providerText.text : ""
  const streamTruncated = text.length >= MAX_STREAM_TEXT_CHARS
  const authoritative = text && !streamTruncated ? text : assembled || text
  // Still bounded: a provider that assembles its own text must not be able to
  // reintroduce the unbounded allocation the stream cap exists to prevent.
  const finalText =
    authoritative.length > MAX_STREAM_TEXT_CHARS ? authoritative.slice(0, MAX_STREAM_TEXT_CHARS) : authoritative
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
      const batch = await Promise.all(
        calls.slice(i, i + limit).map((c) => runOneTool(c, run, state, maxToolCalls)),
      )
      for (const r of batch) if (r) results.push(r)
    }
  }

  for (const r of results) {
    // evil.md class: tool output carrying instruction-override phrasing gets
    // an UNTRUSTED system-reminder appended. The content itself is preserved
    // untouched — it is data the user asked to read.
    run.session.add(annotateUntrustedToolResult(r))
  }
  await run.emit({ type: "turn_end", message: assistant, toolResults: results })
  return results
}

/**
 * Append one tool-gate audit row. Fire-and-forget by contract: the store
 * persists synchronously today, but the gate must survive a throwing,
 * slow, or absent sink — audit is evidence, never control flow.
 */
function recordGateAudit(run: RunConfig, toolName: string, result: string): void {
  try {
    run.audit?.recordAudit("tool.execute", "agent", toolName, result)
  } catch {
    /* audit must never break the turn */
  }
}

/**
 * Append one prompt-guard audit row ("prompt.guard" / kind / refused-or-
 * neutralized). Same fire-and-forget contract as `recordGateAudit`: a
 * failing sink must never turn a security refusal into a crash.
 */
function recordPromptGuardAudit(run: RunConfig, kind: RefusalKind, result: string): void {
  try {
    run.audit?.recordAudit("prompt.guard", "user", kind, result)
  } catch {
    /* audit must never break the turn */
  }
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
      reason: `Nemo detected a repeating tool call loop for ${call.name}. Approval required to continue.`,
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
      recordGateAudit(run, call.name, "doom-loop-denied")
      const denied: ToolResult = {
        content: [{ type: "text", text: `Nemo blocked a repeating tool-call loop for ${call.name}.` }],
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
  // Reserve the tool-call slot SYNCHRONOUSLY, before any await. A Promise.all
  // batch starts every member before ANY of them reaches the increment below
  // respectRate, so with maxToolCalls=1 two parallel calls both passed the
  // guard at once and ran past the limit. Incrementing here (after the last
  // sync guard, before the first await) makes guard+reservation atomic: the
  // first member to check reserves, the rest land on the skip-message path.
  state.toolCalls++
  await respectRate(run.config, state, run.signal)
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
  // Hook payloads are redacted BEFORE hooks run: shell hooks already receive
  // redactPayload output via payloadFor, and this keeps the in-process
  // HookRuntime (plugin/observer hooks, hook history) on the same boundary.
  // Approval, permission prompts, and tool execution keep the raw arguments
  // (the approver must see the real command; the tool needs real inputs).
  const hookArgs = redactPayload(call.arguments)
  // PreToolUse command hooks (config.hooks.preToolUse): user scripts that
  // can block (deny/stop), request approval (ask), or inject context.
  // Denials land as tool errors so the model sees and adapts to them.
  let hookContext: string[] = []
  try {
    const verdict = await runPreToolUseHooks(
      run.config,
      { toolName: call.name, args: hookArgs, cwd: run.config.cwd, signal: run.signal, sessionId: run.sessionId },
      run.hookExecutor,
    )
    hookContext = verdict.additionalContext
    if (verdict.decision === "deny" || verdict.stop) {
      const why = verdict.reason ?? verdict.stopReason ?? `hook denied ${call.name}`
      recordGateAudit(run, call.name, "hook-denied")
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
        recordGateAudit(run, call.name, "approval-declined")
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
  // Single decision point: every tool call flows through approvalFor()
  // (packages/core/src/approval.ts) — deny hard-blocks, ask emits a
  // permission_request, allow proceeds. Denials accumulate on the run's
  // tracker for telemetry and backoff.
  const tracker = run.approvalTracker ?? (run.approvalTracker = new DenialTracker())
  const outcome = approvalFor(call.name, call.arguments, {
    uiMode: effectivePermissions.uiMode,
    config: effectivePermissions,
    tracker,
  })
  const decision = { action: outcome.decision, source: outcome.source, rule: outcome.rule, layer: outcome.layer }
  if (decision.action === "deny") {
    recordGateAudit(run, call.name, "denied")
    const why = decision.rule
      ? `denied by rule [${decision.layer ?? "default"}]: ${decision.rule.tool} ${decision.rule.pattern ? `→ ${decision.rule.pattern}` : ""}`
      : decision.source === "read-only-mode"
        ? "permission mode is read-only"
        : "denied by permission rules"
    const denied: ToolResult = {
      content: [
        {
          type: "text",
          text: `Nemo permission denied for ${call.name}: ${why}. This tool is hidden/blocked under the current permission ruleset.`,
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
          : `Nemo approval required for ${call.name}`,
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
      recordGateAudit(run, call.name, "approval-declined")
      const denied: ToolResult = {
        content: [{ type: "text", text: `Nemo permission denied for ${call.name}. Tool execution blocked.` }],
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
    provider: run.provider,
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
    recordGateAudit(run, call.name, "unknown-tool")
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
    // Per-tool ceiling binds first: a tool declaring timeoutMs dies on its
    // own budget even when the run allows more; the run-wide timeoutMs still
    // caps tools that declare generously (or nothing at all).
    const toolTimeoutMs = tool.definition.timeoutMs
    const timeoutMs = toolTimeoutMs === undefined ? run.config.timeoutMs : Math.min(toolTimeoutMs, run.config.timeoutMs)
    try {
      result = await withTimeout(
        tool.execute(call.id, call.arguments as Record<string, unknown>, run.signal, undefined, context),
        timeoutMs,
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

  recordGateAudit(run, call.name, result.isError ? "error" : "success")

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
      { toolName: call.name, args: hookArgs, cwd: run.config.cwd, signal: run.signal, sessionId: run.sessionId },
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

  const images = toolResultImages(result)
  return {
    role: "tool",
    toolCallId: call.id,
    toolName: call.name,
    content: result.content,
    isError: result.isError,
    // Only kept when the tool actually produced pictures, so an ordinary tool
    // result serializes byte-identically to before (view_image, web_fetch on
    // an image, an MCP screenshot are the only producers).
    ...(images.length > 0 ? { images } : {}),
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
 * Endpoint whose reachability answers "can I reach the thing I need?" (#124).
 *
 * The provider's own base URL, not a public site: probing a third party would
 * report the network as fine while the provider host is the unreachable part.
 * Providers that expose no URL yield an empty string, which disables probing
 * and keeps the previous bounded-retry behaviour.
 */
export function providerProbeUrl(run: { provider?: unknown }): string {
  const options = (run.provider as { options?: { baseUrl?: unknown } } | undefined)?.options
  const raw = options?.baseUrl
  if (typeof raw !== "string" || raw.trim().length === 0) return ""
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return ""
    return parsed.origin
  } catch {
    return ""
  }
}

/**
 * True when a reply is a severed turn rather than a finished one (#122).
 *
 * Only signals that are HONEST about the truncation are accepted. A reply that
 * stopped on a clean `end_turn` cannot be told apart from a short answer, so
 * it is never replayed — guessing would cost a model call on every short reply
 * and could reword a perfectly good answer. The two marks below are emitted by
 * the transport itself when it knows it did not finish:
 *
 *   - `stopReason === "error"` carrying content: the turn failed after it had
 *     already streamed partial output.
 *   - a tool call still carrying the `__partial` marker that `placeholder()`
 *     sets for arguments that were cut off mid tool-call.
 *
 * `length` is deliberately excluded: that is a completed-but-truncated answer
 * and already has its own continuation path.
 */
export function isIncompleteReply(assistant: AssistantMessage): boolean {
  if (assistant.stopReason === "length" || assistant.stopReason === "aborted") return false
  const hasOutput = assistant.content.some(
    (c) => (c.type === "text" && c.text.trim().length > 0) || c.type === "toolCall" || c.type === "thinking",
  )
  if (!hasOutput) return false
  if (assistant.stopReason === "error") return true
  return assistant.content.some(
    (c) => c.type === "toolCall" && Object.prototype.hasOwnProperty.call(c.arguments ?? {}, "__partial"),
  )
}

/**
 * Keep the session inside the model's usable context window.
 * Non-forced: only runs once the estimate crosses the trigger ratio.
 * Forced: runs every stage regardless (reactive overflow / manual /compact).
 * Returns true when the session was rewritten (a `compaction` event is
 * emitted in that case so the UI can show what was freed).
 */
async function ensureContextWithinLimit(run: RunConfig, opts?: { force?: boolean }): Promise<boolean> {
  const policy = policyFromConfig(run.config)
  const systemPrompt = run.session.systemContext
  const before = run.session.messages

  // Agentic first, deterministic as the guarantee.
  //
  // `agenticCompact` never throws and never returns messages that overflow
  // the window — its failure paths degrade to the deterministic marker, and
  // its success path still runs the deterministic pass to guarantee the fit.
  // So the only reason to skip it is when it would be pure latency: a head
  // too small to be worth a model call. `shouldUseAgenticCompaction` answers
  // that without spawning anything.
  let result: AgenticCompactionResult | undefined
  if (
    run.config.agenticCompaction !== false &&
    (opts?.force === true || shouldUseAgenticCompaction(before, policy, { systemPrompt }))
  ) {
    result = await agenticCompact(before, policy, {
      provider: run.provider,
      signal: run.signal,
      systemPrompt,
    })
  }

  const effective =
    result?.strategy === "agentic" ? result : compactMessages(before, policy, { force: opts?.force ?? false, systemPrompt })

  if (!effective.changed) return false
  run.session.clear()
  for (const m of effective.messages) run.session.add(m)
  await run.emit({
    type: "compaction",
    forced: opts?.force ?? false,
    removedMessages: effective.removedMessages,
    prunedToolOutputs: effective.prunedToolOutputs,
    freedTokens: effective.freedTokens,
    estimatedBefore: effective.estimatedBefore,
    estimatedAfter: effective.estimatedAfter,
    // Which path produced this. `agentic-failed` means the model was asked
    // and the deterministic marker answered — visible so a user who sees the
    // same marker every time knows the summarizer is not working, rather
    // than assuming there is no summarizer.
    strategy: result?.strategy,
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
