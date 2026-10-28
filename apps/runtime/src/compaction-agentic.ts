/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Agentic compaction — model-driven history summarization.
 *
 * What this adds to `compactMessages` (compaction.ts)
 * --------------------------------------------------
 * `compactMessages` is DETERMINISTIC and it works: prune oversized tool
 * outputs, truncate, then fold the head into a one-line marker. It never
 * fails and it always frees tokens. What it cannot do is TELL THE MODEL
 * WHAT HAPPENED. The preserved marker says "14 earlier messages were
 * folded" and carries the first line of the original ask — which is enough
 * to survive compaction, and nowhere near enough to CONTINUE the work
 * after it. The agent wakes up knowing it was asked to do something and
 * having no idea what it already tried, which files it touched, or what
 * broke.
 *
 * This module fills that gap: the head is summarized by the MODEL into a
 * structured handoff, and that handoff replaces the marker.
 *
 * The three invariants it must not break
 * --------------------------------------
 * `compactMessages` is the guarantee; this is the fidelity upgrade layered
 * on top of it. So:
 *
 *  1. **It must never throw into a turn.** Every failure path (abort,
 *     provider error, timeout, empty response, unparseable output) degrades
 *     to the deterministic marker. Compaction is not a place to be fragile:
 *     the one moment it is needed is the moment the session is already
 *     largest and the provider is already unhappy.
 *  2. **It must preserve tool-call pairing.** The summary replaces whole
 *     messages, so the split is taken at a USER boundary (the same rule
 *     Stage 3 of the deterministic pass uses) and orphaned leading tool
 *     results are dropped. A `tool_result` with no `tool_call` is a provider
 *     400, and a compaction that causes the 400 it exists to prevent is
 *     worse than no compaction.
 *  3. **It must never lose the task statement.** `splitPinned` carries the
 *     system prefix and the FIRST user message verbatim, because a summary
 *     of "fix the leak in auth.ts" is a paraphrase of the one instruction
 *     that must survive exactly.
 *
 * Why map-reduce rather than one summarization call
 * -------------------------------------------------
 * `packages/core/src/compaction-chunked.ts` documents the two failure modes
 * and they are real: a single call truncates the summary mid-sentence
 * (silent, unrecoverable loss), or overflows the window on input and kills
 * the session. Chunk-then-reduce fixes both, and that module already gets
 * the pairing rules right — so it is used here rather than re-derived.
 *
 * The one thing it adds is the REDUCE step: per-chunk digests concatenated
 * would repeat `<files>` five times and give the model a wall of tags. So
 * the reduce is a second, bounded model call that merges them into one
 * digest. If THAT call fails, the merge is done deterministically
 * (`mergeDigests`) instead — the shape is guaranteed, only the prose is
 * poorer.
 */

import type { AgentMessage, AssistantMessage } from "../../../packages/protocol/src/messages.js"
import type { Provider } from "../../../packages/provider/src/index.js"
import { compactChunked, type Chunk, type ChunkableMessage } from "../../../packages/core/src/compaction-chunked.js"
import {
  compactMessages,
  estimateMessages,
  type CompactionPolicy,
  type CompactionResult,
} from "./compaction.js"

/* ------------------------------------------------------------------ *
 * Digest shape
 * ------------------------------------------------------------------ */

/** Structured handoff that survives compaction and lets work continue. */
export interface SessionDigest {
  /** What the user asked for, in the digest's own words. */
  goal: string
  /** 2-6 sentences: what was attempted and what actually happened. */
  facts: string
  /** `path — status` lines. */
  files: string[]
  /** Verbatim error strings, most important first. */
  errors: string[]
  /** Choices that were made and why. */
  decisions: string[]
  /** Remaining work, in order. */
  todo: string[]
}

export const EMPTY_DIGEST: SessionDigest = {
  goal: "",
  facts: "",
  files: [],
  errors: [],
  decisions: [],
  todo: [],
}

export type AgenticStrategy = "agentic" | "agentic-failed" | "deterministic"

export interface AgenticCompactionResult extends CompactionResult {
  strategy: AgenticStrategy
  /** Present only when the model produced a usable digest. */
  digest?: SessionDigest
  /** How many slices the head was mapped over. */
  chunkCount?: number
}

export interface AgenticCompactionOptions {
  provider: Provider
  signal?: AbortSignal
  /** Wall-clock ceiling for the whole summarization. Default 90s. */
  timeoutMs?: number
  /** Tokens of the tail kept VERBATIM (not summarized). Default 12_000. */
  preserveRecentTokens?: number
  /** Below this head size the model is not worth its latency. Default 6_000. */
  minAgenticTokens?: number
  /** The session's system prompt, included in estimates. */
  systemPrompt?: string
  /** Injectable summarizer for tests; defaults to `summarizeChunkWithModel`. */
  summarize?: (chunk: Chunk, index: number) => Promise<string>
  /** Injectable reductor for tests; defaults to `reduceDigestWithModel`. */
  reduce?: (chunks: readonly string[], signal?: AbortSignal) => Promise<string>
}

/* ------------------------------------------------------------------ *
 * Prompts
 * ------------------------------------------------------------------ */

/**
 * The map prompt. Deliberately constrained: the model is summarizing code
 * work, so the useful output is paths, verbatim errors, and remaining work
 * — not prose. Every section is optional so a slice with no file changes
 * emits an empty `<files>` rather than inventing one, and "never invent
 * facts" is stated because a compactor that hallucinates a file path sends
 * the agent to edit something that never existed.
 */
export const MAP_SYSTEM_PROMPT = `You are the context compactor for an autonomous coding agent.
You are given ONE SLICE of a session transcript. Produce a dense, factual digest of it.

Rules:
- Never invent facts. If something did not happen in this slice, omit it.
- Preserve file paths, command names and error strings VERBATIM.
- Be terse. No preamble, no apology, no markdown outside the tags.
- Emit EXACTLY these sections, in this order, each optional:

<facts>
2-6 sentences: what was attempted here and what actually happened.
</facts>
<files>
One "path — status" per line. Omit entirely if no files were read or changed.
</files>
<errors>
One verbatim error per line, most important first. Omit if none.
</errors>
<decisions>
One decision per line. Omit if none.
</decisions>
<todo>
Remaining work this slice surfaced, one per line, in order. Omit if none.
</todo>`

/**
 * The reduce prompt. Merges per-slice digests into ONE. The duplication
 * problem it exists to solve: five slices each with a `<files>` section
 * give the resumed agent five overlapping file lists and no sense of which
 * entry is current.
 */
export const REDUCE_SYSTEM_PROMPT = `You are merging per-slice digests of one coding session into a single handoff.
The digests below are ordered oldest to newest. Newer information WINS: if an
early digest says a file was "being read" and a later one says it was
"edited", emit only the later state.

Rules:
- Never invent facts. Every line must trace back to a digest below.
- Keep error strings VERBATIM.
- Drop work that a later digest shows is already done.
- Be terse. Emit EXACTLY these sections, in this order:

<goal>
What the user originally asked for, one sentence.
</goal>
<facts>
4-10 sentences: what was attempted across the session and what actually happened.
</facts>
<files>
One "path — status" per line, newest state only.
</files>
<errors>
One verbatim error per line, most important first. Omit if none.
</errors>
<decisions>
One decision per line. Omit if none.
</decisions>
<todo>
Remaining work in priority order. Omit if nothing is left.
</todo>`

/* ------------------------------------------------------------------ *
 * Transcript rendering
 * ------------------------------------------------------------------ */

function textOf(part: unknown): string {
  if (typeof part === "string") return part
  if (part != null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
    return (part as { text: string }).text
  }
  return ""
}

/**
 * Render a slice as plain text for the summarizer.
 *
 * Tool results are truncated per message rather than passed through: a slice
 * that is mostly a 40KB `cat` should summarize the ACTION ("read X, 900
 * lines"), not re-send the file to the model that is compressing it.
 */
export function renderTranscript(messages: readonly ChunkableMessage[], maxCharsPerMessage = 1_200): string {
  const lines: string[] = []
  for (const m of messages) {
    const role = typeof m.role === "string" ? m.role : "unknown"
    if (role === "assistant") {
      const calls = Array.isArray(m.content)
        ? (m.content as unknown[]).filter((p) => p != null && (p as { type?: string }).type === "toolCall")
        : []
      const prose = Array.isArray(m.content)
        ? (m.content as unknown[]).map((p) => textOf(p)).filter((s) => s.length > 0).join(" ")
        : textOf(m.content)
      if (calls.length > 0) {
        const names = calls
          .map((c) => {
            const call = c as { name?: unknown; arguments?: unknown }
            const args = call.arguments == null ? "" : JSON.stringify(call.arguments)
            return `${String(call.name ?? "?")}(${args.length > 200 ? `${args.slice(0, 200)}…` : args})`
          })
          .join("; ")
        lines.push(`assistant called: ${names}${prose.length > 0 ? ` — ${prose}` : ""}`)
      } else if (prose.length > 0) {
        lines.push(`assistant: ${truncateLine(prose, maxCharsPerMessage)}`)
      }
      continue
    }
    if (role === "tool") {
      const text = Array.isArray(m.content)
        ? (m.content as unknown[]).map((p) => textOf(p)).join("\n")
        : textOf(m.content)
      lines.push(`tool result: ${truncateLine(text, maxCharsPerMessage)}`)
      continue
    }
    lines.push(`${role}: ${truncateLine(textOf(m.content), maxCharsPerMessage)}`)
  }
  return lines.join("\n")
}

function truncateLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/* ------------------------------------------------------------------ *
 * Digest parsing — tolerant by design
 * ------------------------------------------------------------------ */

const SECTIONS: ReadonlyArray<{ key: keyof SessionDigest; tag: string; multiline: boolean }> = [
  { key: "goal", tag: "goal", multiline: false },
  { key: "facts", tag: "facts", multiline: false },
  { key: "files", tag: "files", multiline: true },
  { key: "errors", tag: "errors", multiline: true },
  { key: "decisions", tag: "decisions", multiline: true },
  { key: "todo", tag: "todo", multiline: true },
]

/**
 * Extract a digest from model output.
 *
 * Tolerant on purpose: a model that emits the right content with the wrong
 * casing, extra whitespace, or a stray closing tag still yields a usable
 * digest. Strict parsing here would throw away good work over formatting,
 * and the caller would fall back to the deterministic marker — which is a
 * worse outcome than a slightly ragged digest.
 *
 * A section that is MISSING or EMPTY becomes `""` / `[]`; it never throws.
 */
export function parseDigest(text: string): SessionDigest {
  const digest: SessionDigest = { ...EMPTY_DIGEST }
  const flat = text ?? ""
  for (const { key, tag, multiline } of SECTIONS) {
    const re = new RegExp(`<${tag}\\s*>([\\s\\S]*?)</${tag}\\s*>`, "i")
    const body = re.exec(flat)?.[1]?.trim() ?? ""
    if (multiline) {
      const items = body
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
        .filter((line) => line.length > 0)
      ;(digest[key] as string[]) = dedupe(items)
    } else {
      ;(digest[key] as string) = body.replace(/\s+/g, " ").trim()
    }
  }
  return digest
}

function dedupe(items: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * Deterministic merge — the fallback when the reduce model call fails.
 *
 * Union semantics rather than "newest wins": without a model to judge which
 * entry is current, keeping both a stale and a fresh file status is the only
 * honest option. `todo` is the one list where stale entries are actively
 * harmful (the agent re-does finished work), so it is kept in full and the
 * reduce prompt is what normally prunes it.
 */
export function mergeDigests(digests: readonly SessionDigest[]): SessionDigest {
  const merged: SessionDigest = { ...EMPTY_DIGEST }
  for (const d of digests) {
    if (!d) continue
    if (!merged.goal && d.goal) merged.goal = d.goal
    if (d.facts) merged.facts = merged.facts ? `${merged.facts} ${d.facts}` : d.facts
    merged.files = dedupe([...merged.files, ...d.files])
    merged.errors = dedupe([...merged.errors, ...d.errors])
    merged.decisions = dedupe([...merged.decisions, ...d.decisions])
    merged.todo = dedupe([...merged.todo, ...d.todo])
  }
  return merged
}

/* ------------------------------------------------------------------ *
 * Digest rendering back into a message
 * ------------------------------------------------------------------ */

/**
 * Turn a digest into the message that replaces the folded head.
 *
 * Role is `user`, matching the deterministic marker, and the body opens with
 * an `[internal:context-handoff]` tag — the same convention the loop already
 * uses for `[internal:nudge]`, so both the UI and the model can tell a
 * machine-generated turn from something the human actually typed. Getting
 * this wrong in the other direction (an untagged "user" message that the
 * user never wrote) is how an agent ends up arguing with its own summary.
 */
export function renderDigestMessage(digest: SessionDigest, contextWindowTokens: number): AgentMessage {
  const blocks: string[] = [
    `[internal:context-handoff] Earlier turns were summarized to keep this session inside the ${contextWindowTokens}-token window. This is a machine-generated handoff, not a user message. Continue from it.`,
  ]
  if (digest.goal) blocks.push(`GOAL: ${digest.goal}`)
  if (digest.facts) blocks.push(`WHAT HAPPENED: ${digest.facts}`)
  if (digest.files.length > 0) blocks.push(`FILES:\n${digest.files.map((f) => `- ${f}`).join("\n")}`)
  if (digest.errors.length > 0) blocks.push(`ERRORS SEEN:\n${digest.errors.map((e) => `- ${e}`).join("\n")}`)
  if (digest.decisions.length > 0) {
    blocks.push(`DECISIONS:\n${digest.decisions.map((d) => `- ${d}`).join("\n")}`)
  }
  if (digest.todo.length > 0) blocks.push(`REMAINING WORK:\n${digest.todo.map((t) => `- ${t}`).join("\n")}`)
  return { role: "user", content: blocks.join("\n\n") }
}

/* ------------------------------------------------------------------ *
 * Split selection
 * ------------------------------------------------------------------ */

export interface Split {
  /** Everything before `split` is summarized. */
  head: AgentMessage[]
  /** Everything from `split` is kept verbatim. */
  tail: AgentMessage[]
  /** True when the split landed on a safe boundary. */
  safe: boolean
}

/**
 * Choose where the verbatim tail begins.
 *
 * Rules, in order:
 *  1. Walk backwards from the end accumulating token estimates until the
 *     preserve budget is met.
 *  2. Snap the boundary FORWARD to a `user` message. A split anywhere else
 *     can orphan a tool result from its call — the 400 the compaction is
 *     meant to prevent.
 *  3. If no user boundary exists at all, the head is empty: there is nothing
 *     to summarize that is not the task statement, and the deterministic
 *     pass can handle the rest.
 */
export function chooseSplit(messages: readonly AgentMessage[], preserveTokens: number): Split {
  let acc = 0
  let split = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateMessages([messages[i]!])
    split = i
    if (acc >= preserveTokens) break
  }

  for (let i = split; i < messages.length; i++) {
    if (messages[i]!.role === "user") {
      split = i
      return { head: messages.slice(0, split) as AgentMessage[], tail: messages.slice(split) as AgentMessage[], safe: true }
    }
  }
  // No user boundary ahead of the budget: summarize nothing rather than risk
  // an orphaned tool result.
  return { head: [], tail: messages.slice() as AgentMessage[], safe: false }
}

/* ------------------------------------------------------------------ *
 * Model calls — bounded
 * ------------------------------------------------------------------ */

function assistantText(m: AssistantMessage | null): string {
  if (!m || !Array.isArray(m.content)) return ""
  return m.content
    .map((part) => (part != null && typeof part === "object" && "text" in part ? String(part.text ?? "") : ""))
    .join("\n")
    .trim()
}

/** Provider call with an abort signal and a wall-clock ceiling. */
async function callModel(
  provider: Provider,
  system: string,
  user: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`agentic compaction timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  try {
    const result = await Promise.race([
      provider.chat({
        system,
        messages: [{ role: "user", content: user }],
        signal,
        callbacks: {},
      }),
      timeout,
    ])
    const text = assistantText(result)
    if (text.length === 0) throw new Error("empty summary response")
    return text
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Default map summarizer: one bounded provider call per slice. */
export function summarizeChunkWithModel(
  provider: Provider,
  timeoutMs: number,
  signal?: AbortSignal,
): (chunk: Chunk, index: number) => Promise<string> {
  return async (chunk: Chunk): Promise<string> => {
    const transcript = renderTranscript(chunk.messages as ChunkableMessage[])
    return callModel(provider, MAP_SYSTEM_PROMPT, transcript, timeoutMs, signal)
  }
}

/** Default reductor: merges per-slice digests into one. */
export function reduceDigestWithModel(
  provider: Provider,
  timeoutMs: number,
  signal?: AbortSignal,
): (chunks: readonly string[], signal?: AbortSignal) => Promise<string> {
  return async (chunks: readonly string[]): Promise<string> => {
    const input = chunks.filter((c) => c.trim().length > 0).join("\n\n--- slice ---\n\n")
    if (input.length === 0) throw new Error("nothing to reduce")
    return callModel(provider, REDUCE_SYSTEM_PROMPT, input, timeoutMs, signal)
  }
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

/**
 * Agentic compaction with a guaranteed outcome.
 *
 * Never throws and never returns something that breaks the session: the
 * return is always a valid `CompactionResult`-shaped object whose messages
 * fit the policy window. The only thing that varies is `strategy`, which
 * tells the caller how much fidelity it got.
 *
 *   - `"agentic"`          model digest replaced the marker
 *   - `"agentic-failed"`   the model path failed; deterministic marker used
 *   - `"deterministic"`    the head was too small to be worth a model call
 */
export async function agenticCompact(
  messages: readonly AgentMessage[],
  policy: CompactionPolicy,
  opts: AgenticCompactionOptions,
): Promise<AgenticCompactionResult> {
  const systemPrompt = opts.systemPrompt ?? ""
  const estimatedBefore = estimateMessages(messages, systemPrompt)
  const timeoutMs = Math.max(1_000, opts.timeoutMs ?? 90_000)
  const preserveTokens = opts.preserveRecentTokens ?? 12_000
  const minAgenticTokens = opts.minAgenticTokens ?? 6_000

  const fallback = (strategy: AgenticStrategy, digest?: SessionDigest, chunkCount?: number): AgenticCompactionResult => {
    const result = compactMessages(messages, policy, { force: true, systemPrompt })
    return { ...result, strategy, ...(digest === undefined ? {} : { digest }), ...(chunkCount === undefined ? {} : { chunkCount }) }
  }

  if (opts.signal?.aborted) return fallback("agentic-failed")

  const split = chooseSplit(messages, preserveTokens)
  if (!split.safe || split.head.length === 0) return fallback("deterministic")

  const headTokens = estimateMessages(split.head)
  if (headTokens < minAgenticTokens) return fallback("deterministic")

  const summarize = opts.summarize ?? summarizeChunkWithModel(opts.provider, timeoutMs, opts.signal)
  const reduce = opts.reduce ?? reduceDigestWithModel(opts.provider, timeoutMs, opts.signal)

  let digestText: string
  let chunkCount = 0
  try {
    const chunked = await compactChunked(split.head as ChunkableMessage[], {
      maxChunkTokens: 8_000,
      hardCapTokens: 24_000,
      summarize,
      maxSummaryChars: 24_000,
    })
    chunkCount = chunked.chunkCount
    digestText = await reduce(chunked.parts)
  } catch {
    // Model path failed for any reason (abort, HTTP, timeout, empty).
    // The deterministic marker is a strictly better outcome than a thrown
    // compaction: the session was already at its largest here.
    return fallback("agentic-failed")
  }

  const digest = parseDigest(digestText)
  if (digest.goal.length === 0 && digest.facts.length === 0) {
    // The model answered, but with nothing usable. Keeping the raw text as
    // `facts` preserves more than discarding it would.
    digest.facts = truncateLine(digestText, 4_000)
  }

  // Replace the head with the handoff, then let the deterministic engine
  // guarantee the window fit. The digest is one message; the tail is
  // verbatim; `compactMessages` still has every stage available if the
  // combination is still too large.
  const handoff = renderDigestMessage(digest, policy.contextWindowTokens)
  const rebuilt: AgentMessage[] = [handoff, ...split.tail]

  const fitted = compactMessages(rebuilt, policy, { force: true, systemPrompt })
  if (!fitted.changed) {
    return {
      messages: rebuilt,
      changed: true,
      removedMessages: split.head.length,
      prunedToolOutputs: 0,
      freedTokens: Math.max(0, estimatedBefore - estimateMessages(rebuilt, systemPrompt)),
      estimatedBefore,
      estimatedAfter: estimateMessages(rebuilt, systemPrompt),
      actions: ["drop"],
      strategy: "agentic",
      digest,
      chunkCount,
    }
  }
  return { ...fitted, strategy: "agentic", digest, chunkCount }
}

/** True when the head is large enough that a model summary is worth its latency. */
export function shouldUseAgenticCompaction(
  messages: readonly AgentMessage[],
  policy: CompactionPolicy,
  opts: { preserveRecentTokens?: number; minAgenticTokens?: number; systemPrompt?: string },
): boolean {
  const usable = Math.max(1024, policy.contextWindowTokens - policy.completionReserveTokens)
  const trigger = usable * policy.triggerRatio
  const estimated = estimateMessages(messages, opts.systemPrompt ?? "")
  if (estimated <= trigger) return false
  const split = chooseSplit(messages, opts.preserveRecentTokens ?? 12_000)
  if (!split.safe || split.head.length === 0) return false
  return estimateMessages(split.head) >= (opts.minAgenticTokens ?? 6_000)
}
