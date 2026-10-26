/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Context compaction engine (ported from Shrijan Code's SessionCompaction
 * design: https://github.com/…/packages/opencode/src/session/compaction.ts).
 *
 * Strategy, applied in escalating stages until the session fits inside the
 * model's usable context window:
 *
 *   1. PRUNE    — Shrijan's walk-backwards rule: keep the newest
 *      `pruneProtectTokens` (40k) worth of tool outputs verbatim, then mark
 *      older ones as pruned — but only when that frees more than
 *      `pruneMinimumTokens` (20k). Runs before truncation so it sees the
 *      original output sizes, like Shrijan.
 *   2. TRUNCATE — cut whatever oversized tool outputs remain in the head
 *      (outside the preserved tail) down to `toolOutputMaxChars`, keeping
 *      head+tail of each output.
 *   3. DROP     — fold everything before a USER-message boundary (keeps
 *      assistant↔tool pairing intact, like Shrijan's turn-based split) into a
 *      single compacting marker message that preserves the original ask and
 *      intermediate questions.
 *   4. LAST RESORT — strip leading blocks, then shrink the largest message
 *      contents until the session fits (guarantees progress).
 *
 * The invariant every stage preserves: every `tool` message follows the
 * assistant message whose `toolCall.id` it answers, and every toolCall has
 * its result — providers reject broken pairing with a 400.
 */

import type { AgentMessage, AssistantMessage, ToolResultMessage } from "../../../packages/protocol/src/messages.js"

export type CompactionAction = "truncate" | "prune" | "drop"

export interface CompactionPolicy {
  /** Total model context window in tokens. */
  contextWindowTokens: number
  /** Reserved tokens for the completion (config.maxTokens). */
  completionReserveTokens: number
  /** Proactive trigger: compact when the estimate exceeds usable × ratio. */
  triggerRatio: number
  /** Newest messages that stages 1–2 never touch. */
  preserveRecentMessages: number
  /** Per-tool-output hard cap in chars when truncating (Shrijan: 2_000). */
  toolOutputMaxChars: number
  /** Newest tool-output tokens kept verbatim by prune (Shrijan: 40_000). */
  pruneProtectTokens: number
  /** Prune only fires when it frees more than this (Shrijan: 20_000). */
  pruneMinimumTokens: number
  /** Tool names whose outputs are never pruned (Shrijan: ["skill"]). */
  protectedTools: string[]
}

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  contextWindowTokens: 128_000,
  completionReserveTokens: 4_096,
  triggerRatio: 0.7,
  preserveRecentMessages: 10,
  toolOutputMaxChars: 2_000,
  pruneProtectTokens: 40_000,
  pruneMinimumTokens: 20_000,
  protectedTools: ["skill"],
}

export interface CompactionResult {
  messages: AgentMessage[]
  changed: boolean
  /** Messages removed by the drop stages (folded into a marker). */
  removedMessages: number
  /** Tool outputs replaced by a pruned marker. */
  prunedToolOutputs: number
  freedTokens: number
  estimatedBefore: number
  estimatedAfter: number
  actions: CompactionAction[]
}

export interface CompactOptions {
  /** Bypass the trigger gate (manual /compact). */
  force?: boolean
  /** The session's system prompt, included in estimates. */
  systemPrompt?: string
}

const OVERHEAD_TOKENS = 4

function ceilDiv(n: number): number {
  return Math.ceil(n / 4)
}

/** Char count that tolerates corrupt persisted messages (#88): non-string
 *  content must estimate, not NaN — a NaN session total makes every
 *  `total <= usable * triggerRatio` gate false and compaction stays OFF
 *  until the provider 400s on overflow. Circular-safe. */
function charsOf(value: unknown): number {
  if (typeof value === "string") return value.length
  if (value == null) return 0
  try {
    const json = JSON.stringify(value)
    return typeof json === "string" ? json.length : String(value).length
  } catch {
    return String(value).length
  }
}

/** Rough token estimate for a single message (~chars/4 + per-message overhead).
 *  Total over any input: corrupt roles/content estimate finitely, never NaN. */
export function estimateMessageTokens(m: AgentMessage): number {
  if (typeof m !== "object" || m === null) return OVERHEAD_TOKENS
  switch (m.role) {
    case "system":
    case "user":
      return ceilDiv(charsOf(m.content)) + OVERHEAD_TOKENS
    case "assistant": {
      if (!Array.isArray(m.content)) return ceilDiv(charsOf(m.content)) + OVERHEAD_TOKENS
      let chars = 0
      for (const part of m.content) {
        if (part == null) continue
        if (part.type === "toolCall") {
          chars += charsOf(part.name) + charsOf(part.arguments ?? {})
        } else {
          chars += charsOf((part as { text?: string }).text)
        }
      }
      return ceilDiv(chars) + OVERHEAD_TOKENS
    }
    case "tool": {
      if (!Array.isArray(m.content)) return ceilDiv(charsOf(m.content)) + OVERHEAD_TOKENS
      let chars = 0
      for (const part of m.content) chars += charsOf(part?.text)
      return ceilDiv(chars) + OVERHEAD_TOKENS
    }
    default:
      // Corrupt persisted role (#88): falling off the switch returned
      // `undefined`, which NaN'd the session total on the next `+=`.
      return ceilDiv(charsOf((m as { content?: unknown }).content)) + OVERHEAD_TOKENS
  }
}

/** Session token estimate, optionally including the system prompt.
 *  Fail-safe (#88): a non-finite total must force the compaction path
 *  (over-compact), never compare false and disable it (overflow → 400). */
export function estimateMessages(messages: readonly AgentMessage[], systemPrompt = ""): number {
  let total = systemPrompt ? ceilDiv(systemPrompt.length) : 0
  for (const m of messages) total += estimateMessageTokens(m)
  return Number.isFinite(total) ? total : Number.MAX_SAFE_INTEGER
}

/** Build a policy from (possibly partial) runtime config. */
export function policyFromConfig(cfg: { contextWindow?: number; maxTokens?: number }): CompactionPolicy {
  const contextWindow =
    typeof cfg.contextWindow === "number" && Number.isFinite(cfg.contextWindow) && cfg.contextWindow > 0
      ? cfg.contextWindow
      : DEFAULT_COMPACTION_POLICY.contextWindowTokens
  const completionReserve =
    typeof cfg.maxTokens === "number" && Number.isFinite(cfg.maxTokens) && cfg.maxTokens > 0
      ? cfg.maxTokens
      : DEFAULT_COMPACTION_POLICY.completionReserveTokens
  return {
    ...DEFAULT_COMPACTION_POLICY,
    contextWindowTokens: contextWindow,
    completionReserveTokens: completionReserve,
  }
}

function usableTokens(policy: CompactionPolicy): number {
  return Math.max(1024, policy.contextWindowTokens - policy.completionReserveTokens)
}

/** Head+tail truncation that keeps a marker in the middle. */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const marker = `\n…[truncated ${text.length} chars to fit the context window]…\n`
  const budget = Math.max(0, maxChars - marker.length)
  const head = Math.floor(budget * 0.75)
  const tail = budget - head
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(text.length - tail) : "")
}

function firstLine(text: string, max: number): string {
  const line = text.split(/\r?\n/, 1)[0] ?? ""
  return line.length > max ? `${line.slice(0, max)}…` : line
}

function joinedToolText(m: ToolResultMessage): string {
  return m.content.map((c) => c.text).join("\n")
}

function hasToolCalls(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && m.content.some((c) => c.type === "toolCall")
}

function cloneAssistantShrunk(m: AssistantMessage, maxPartChars: number): AssistantMessage | null {
  // Shrink the single largest text/thinking part.
  let idx = -1
  let largest = 0
  for (let i = 0; i < m.content.length; i++) {
    const part = m.content[i]!
    if (part.type === "toolCall") continue
    const len = (part as { text?: string }).text?.length ?? 0
    if (len > largest) {
      largest = len
      idx = i
    }
  }
  if (idx < 0 || largest <= maxPartChars) return null
  const content = m.content.map((part, i) =>
    i === idx ? { ...part, text: truncateText((part as { text: string }).text, maxPartChars) } : part,
  )
  return { ...m, content }
}

function shrinkMessage(m: AgentMessage, targetChars: number): AgentMessage | null {
  switch (m.role) {
    case "user":
    case "system":
      return m.content.length > targetChars ? { ...m, content: truncateText(m.content, targetChars) } : null
    case "tool": {
      const joined = joinedToolText(m)
      return joined.length > targetChars
        ? { ...m, content: [{ type: "text" as const, text: truncateText(joined, targetChars) }] }
        : null
    }
    case "assistant":
      return cloneAssistantShrunk(m, targetChars)
  }
}

/**
 * Compact `messages` so the session fits the policy's usable context window.
 * Pure: returns a new array (kept messages share references where untouched).
 */
export function compactMessages(
  messages: readonly AgentMessage[],
  policy: CompactionPolicy,
  opts: CompactOptions = {},
): CompactionResult {
  const systemPrompt = opts.systemPrompt ?? ""
  const estimatedBefore = estimateMessages(messages, systemPrompt)
  const usable = usableTokens(policy)
  const actions: CompactionAction[] = []
  let removedMessages = 0
  let prunedToolOutputs = 0
  let freedTokens = 0

  const noop = (): CompactionResult => ({
    messages: messages as AgentMessage[],
    changed: false,
    removedMessages: 0,
    prunedToolOutputs: 0,
    freedTokens: 0,
    estimatedBefore,
    estimatedAfter: estimatedBefore,
    actions: [],
  })

  if (!opts.force && estimatedBefore <= usable * policy.triggerRatio) return noop()

  let out: AgentMessage[] = [...messages]
  const tailStart = Math.max(0, out.length - policy.preserveRecentMessages)

  // Stage 1 — Shrijan prune: walk backwards, protect the newest
  // pruneProtectTokens of tool outputs, mark older candidates as pruned.
  {
    let cumulative = 0
    const candidates: Array<{ i: number; tokens: number }> = []
    for (let i = out.length - 1; i >= 0; i--) {
      const m = out[i]!
      if (m.role !== "tool") continue
      if (i >= tailStart) continue // tail outputs are never pruned
      if (policy.protectedTools.includes(m.toolName)) continue
      const t = estimateMessageTokens(m)
      cumulative += t
      if (cumulative <= policy.pruneProtectTokens) continue
      candidates.push({ i, tokens: t })
    }
    const prunable = candidates.reduce((sum, c) => sum + c.tokens, 0)
    if (prunable > policy.pruneMinimumTokens) {
      for (const { i, tokens } of candidates) {
        const m = out[i]! as ToolResultMessage
        const marker = `[${m.toolName} output pruned — ~${tokens} tokens freed to stay within context]`
        out[i] = { ...m, content: [{ type: "text", text: marker }] }
        freedTokens += Math.max(0, tokens - (ceilDiv(marker.length) + OVERHEAD_TOKENS))
        prunedToolOutputs++
      }
      actions.push("prune")
    }
  }

  // Stage 2 — truncate oversized tool outputs outside the preserved tail.
  for (let i = 0; i < tailStart; i++) {
    const m = out[i]!
    if (m.role !== "tool") continue
    const text = joinedToolText(m)
    if (text.length <= policy.toolOutputMaxChars) continue
    const before = estimateMessageTokens(m)
    out[i] = { ...m, content: [{ type: "text" as const, text: truncateText(text, policy.toolOutputMaxChars) }] }
    freedTokens += Math.max(0, before - estimateMessageTokens(out[i]!))
    if (!actions.includes("truncate")) actions.push("truncate")
  }

  // Stage 3 — fold the head into a marker, splitting on a USER boundary so
  // assistant/tool pairing survives (Shrijan splits on turn starts too).
  const afterStages12 = estimateMessages(out, systemPrompt)
  if (afterStages12 > usable) {
    const userBoundaries: number[] = []
    for (let i = 1; i < out.length; i++) {
      if (out[i]!.role === "user") userBoundaries.push(i)
    }
    let split = -1
    if (userBoundaries.length > 0) {
      const target = usable * 0.95
      for (const boundary of userBoundaries) {
        const suffixTokens = estimateMessages(out.slice(boundary), systemPrompt)
        if (suffixTokens <= target) {
          split = boundary
          break // smallest boundary that fits → keeps the most context
        }
      }
      if (split === -1) split = userBoundaries[userBoundaries.length - 1]!
    }

    if (split > 0) {
      const head = out.slice(0, split)
      const tail = out.slice(split)
      const dropped = estimateMessages(head)
      const asks = head
        .filter((m): m is Extract<AgentMessage, { role: "user" }> => m.role === "user")
        .map((m) => firstLine(m.content, 90))
      const markerText =
        `[Context auto-compaction] ${head.length} earlier messages (~${dropped} tokens) were folded to keep this session inside the ${policy.contextWindowTokens}-token window.` +
        (asks.length > 0
          ? ` Original request: «${asks[0]}»` +
            (asks.length > 1
              ? ` Later asks: ${asks
                  .slice(1, 6)
                  .map((a) => `«${a}»`)
                  .join(" · ")}`
              : "")
          : "")
      const marker: AgentMessage = { role: "user", content: markerText }
      out = [marker, ...tail]
      removedMessages += head.length
      freedTokens += Math.max(0, dropped - estimateMessageTokens(marker))
      actions.push("drop")
    } else if (out.length > policy.preserveRecentMessages) {
      // No usable user boundary (unusual) → strip leading blocks instead.
      split = Math.max(1, out.length - policy.preserveRecentMessages)
      out = out.slice(split)
      removedMessages += split
      actions.push("drop")
    }
  }

  // Stage 4a — last resort: truncate tool outputs EVERYWHERE (tail included).
  let est = estimateMessages(out, systemPrompt)
  if (est > usable) {
    for (let i = 0; i < out.length; i++) {
      const m = out[i]!
      if (m.role !== "tool") continue
      const text = joinedToolText(m)
      if (text.length <= policy.toolOutputMaxChars) continue
      const before = estimateMessageTokens(m)
      out[i] = { ...m, content: [{ type: "text", text: truncateText(text, policy.toolOutputMaxChars) }] }
      freedTokens += Math.max(0, before - estimateMessageTokens(out[i]!))
      if (!actions.includes("truncate")) actions.push("truncate")
    }
    est = estimateMessages(out, systemPrompt)
  }

  // Stage 4b — strip leading messages in pairing-safe units until it fits.
  let rounds = 0
  while (est > usable && out.length > 3 && rounds < 200) {
    rounds++
    const first = out[0]!
    let cut = 1
    if (hasToolCalls(first)) {
      while (cut < out.length && out[cut]!.role === "tool") cut++ // remove call + its results together
    } else if (first.role === "tool") {
      cut = 1 // orphaned/leading result — safe to drop
    }
    const removed = out.slice(0, cut)
    out = out.slice(cut)
    removedMessages += removed.length
    freedTokens += removed.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
    while (out.length > 0 && out[0]!.role === "tool") {
      // Never leave a tool result whose assistant call was just removed.
      const orphan = out[0]!
      out = out.slice(1)
      removedMessages++
      freedTokens += estimateMessageTokens(orphan)
    }
    if (!actions.includes("drop")) actions.push("drop")
    est = estimateMessages(out, systemPrompt)
  }

  // Stage 4c — shrink the largest message contents until it fits.
  rounds = 0
  while (est > usable && rounds < 12) {
    rounds++
    let idx = -1
    let largest = 0
    for (let i = 0; i < out.length; i++) {
      const t = estimateMessageTokens(out[i]!)
      if (t > largest) {
        largest = t
        idx = i
      }
    }
    if (idx < 0 || largest <= 1024) break
    const target = Math.max(512, Math.floor(largest / 2))
    const shrunk = shrinkMessage(out[idx]!, target)
    if (!shrunk) break
    freedTokens += Math.max(0, largest - estimateMessageTokens(shrunk))
    out[idx] = shrunk
    if (!actions.includes("truncate")) actions.push("truncate")
    est = estimateMessages(out, systemPrompt)
  }

  const estimatedAfter = estimateMessages(out, systemPrompt)
  const changed = actions.length > 0
  if (!changed) {
    return {
      messages: messages as AgentMessage[],
      changed: false,
      removedMessages: 0,
      prunedToolOutputs: 0,
      freedTokens: 0,
      estimatedBefore,
      estimatedAfter,
      actions,
    }
  }
  return {
    messages: out,
    changed,
    removedMessages,
    prunedToolOutputs,
    freedTokens,
    estimatedBefore,
    estimatedAfter,
    actions,
  }
}
