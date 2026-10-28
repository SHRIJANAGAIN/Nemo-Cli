/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Chunked map-reduce compaction.
 *
 * A single summarize call over a long conversation has two failure modes that
 * both get worse exactly when compaction is needed most:
 *
 *  1. The SUMMARY is truncated by the provider's output limit. You then discard
 *     the conversation and keep a summary that stops mid-sentence — the loss is
 *     silent and unrecoverable.
 *  2. The INPUT overflows the context window, so the call fails outright and the
 *     session dies at the worst moment.
 *
 * Summarizing each slice independently and then reducing fixes both: every chunk
 * summary is small enough to finish, and no single request is larger than the
 * window.
 *
 * The subtlety this module exists to get right is message PAIRING. A
 * `tool_result` whose `tool_call` landed in the previous chunk is an orphan, and
 * a provider will reject it — or worse, accept it and drop the call, leaving the
 * transcript describing a result nothing produced. So chunking never splits a
 * pair, and the pinned prefix (system prompt, opening intent) is never chunked
 * at all: it is carried verbatim into the reduce step, because a summary of the
 * user's original request is a paraphrase of the request, and paraphrasing the
 * one instruction that must survive verbatim is how an agent loses its task.
 */

/** Minimal shape this module needs; deliberately not the full wire type. */
export interface ChunkableMessage {
  readonly role: string
  readonly content: unknown
  /** Present on an assistant tool call and on its matching result. */
  readonly toolCallId?: string
  /**
   * Every call this message opens.
   *
   * An assistant turn routinely emits SEVERAL tool calls in one message, and a
   * single `toolCallId` cannot express that. Tracking one id made the chunker
   * believe the group was resolved as soon as the first result arrived, so the
   * remaining calls could be split from their results.
   */
  readonly toolCallIds?: readonly string[]
  /** True for the assistant message that CARRIES the tool call. */
  readonly hasToolCalls?: boolean
}

/** One slice of the conversation, summarised independently. */
export interface Chunk {
  readonly index: number
  readonly total: number
  readonly messages: readonly ChunkableMessage[]
  /** Cheap token estimate, so callers can report progress without a tokenizer. */
  readonly estimatedTokens: number
}

export interface ChunkOptions {
  /** Target tokens per chunk. Default 8000. */
  readonly maxChunkTokens?: number
  /** Hard ceiling, so one enormous message cannot produce a huge chunk. Default 24000. */
  readonly hardCapTokens?: number
  /** Per-message token estimate. Default: chars/4, matching the core estimator. */
  readonly estimate?: (message: ChunkableMessage) => number
}

/** Default estimate: four characters per token is the standard approximation. */
function defaultEstimate(message: ChunkableMessage): number {
  return Math.ceil(JSON.stringify(message.content ?? "").length / 4)
}

/**
 * Split the pinned prefix from the rest.
 *
 * Pinned = every `system` message plus everything up to and including the first
 * `user` message. That is the task statement; it survives into the reduce step
 * verbatim.
 */
export function splitPinned(messages: readonly ChunkableMessage[]): {
  pinned: ChunkableMessage[]
  rest: ChunkableMessage[]
} {
  const pinned: ChunkableMessage[] = []
  let index = 0
  while (index < messages.length && messages[index]?.role === "system") {
    pinned.push(messages[index] as ChunkableMessage)
    index++
  }
  // The task statement is "everything up to AND INCLUDING the first user
  // message". A conversation that opens with an assistant turn — a resumed or
  // continued session, a queued follow-up — still has its task statement
  // somewhere ahead; pinning only the system prefix lets that one instruction
  // be paraphrased by a chunk summary, which is precisely the failure this
  // module exists to prevent. Only when NO user message exists at all (no task
  // to preserve) do we stop at the system prefix.
  const firstUser = messages.findIndex((m, i) => i >= index && m.role === "user")
  if (firstUser >= 0) {
    while (index <= firstUser) {
      pinned.push(messages[index] as ChunkableMessage)
      index++
    }
  }
  return { pinned, rest: messages.slice(index) }
}

/** Every call id this message opens. */
function openedIds(message: ChunkableMessage): string[] {
  const ids: string[] = []
  if (Array.isArray(message.toolCallIds)) ids.push(...message.toolCallIds.filter((id) => typeof id === "string"))
  if (typeof message.toolCallId === "string" && !ids.includes(message.toolCallId)) ids.push(message.toolCallId)
  return ids
}

/**
 * Split into chunks that never break a tool pair.
 *
 * Greedy by token budget rather than fixed message counts, because message sizes
 * vary by three orders of magnitude (a one-line ack vs a pasted file) and a
 * count-based split would produce wildly uneven chunks.
 *
 * The pairing invariant is enforced as a RULE, not as a repair. The earlier
 * version tried to FIX splits after the fact by pushing a stray result back into
 * the previous chunk — which silently rewrote a chunk that had already been
 * emitted and counted, and with more than one call in flight did not fire at all.
 * Overrunning the budget slightly is a far smaller failure than an orphan, so a
 * boundary is only taken when nothing is outstanding.
 */
export function chunkMessages(messages: readonly ChunkableMessage[], options: ChunkOptions = {}): Chunk[] {
  const estimate = options.estimate ?? defaultEstimate
  const budget = options.maxChunkTokens ?? 8_000
  const hardCap = options.hardCapTokens ?? 24_000

  const chunks: Chunk[] = []
  let current: ChunkableMessage[] = []
  let currentTokens = 0
  /**
   * Calls opened but not yet answered. Deliberately NOT reset by `flush`: it spans
   * chunks on purpose, because forbidding a boundary while a pair is in flight is
   * the entire mechanism.
   */
  const unresolved = new Set<string>()

  const flush = (): void => {
    if (current.length === 0) return
    chunks.push({ index: chunks.length, total: 0, messages: current, estimatedTokens: currentTokens })
    current = []
    currentTokens = 0
  }

  for (const message of messages) {
    const size = estimate(message)

    const isResult = message.role === "tool" && message.toolCallId !== undefined
    const overBudget = currentTokens + size > budget
    // A tool RESULT also blocks a boundary: its call may be in an earlier chunk.
    const blocked = unresolved.size > 0 || isResult
    if (current.length > 0 && overBudget && !blocked) {
      flush()
    }

    // One message larger than the budget still gets its own chunk rather than
    // being dropped or split mid-JSON.
    current.push(message)
    currentTokens += size
    for (const id of openedIds(message)) unresolved.add(id)
    if (isResult && message.toolCallId !== undefined) unresolved.delete(message.toolCallId)
    // Only a fully resolved chunk is sealed early by the hard cap; otherwise a
    // multi-call group would be torn in half at an arbitrary point.
    if (currentTokens >= hardCap && unresolved.size === 0) flush()
  }
  flush()

  return chunks.map((c, i) => ({ ...c, index: i, total: chunks.length }))
}

/**
 * Join chunk summaries, newest last, under a per-chunk budget.
 *
 * The newest chunk is kept VERBATIM rather than truncated: recency is what the
 * agent is about to act on, so it is the last thing worth losing. Older
 * summaries are dropped tail-first once the budget is exceeded, because that
 * ordering is deterministic — a summary that silently varies in length between
 * runs makes a compacted session impossible to compare.
 */
export function reduceSummaries(summaries: readonly string[], maxChars = 24_000): string {
  const kept: string[] = []
  let used = 0
  for (let i = summaries.length - 1; i >= 0; i--) {
    const text = summaries[i] ?? ""
    const cost = text.length + 2
    if (used + cost > maxChars && kept.length > 0) break
    kept.unshift(text)
    used += cost
  }
  return kept.join("\n\n")
}

export interface ChunkedCompactionOptions extends ChunkOptions {
  readonly maxSummaryChars?: number
  /** Called once per chunk; may be async. */
  readonly summarize: (chunk: Chunk, index: number) => Promise<string>
  /** Optional progress hook, so the UI can show "compacting 3/9". */
  readonly onProgress?: (done: number, total: number) => void
}

export interface ChunkedCompactionResult {
  readonly summary: string
  readonly chunkCount: number
  /** Per-chunk summaries, for diagnostics and for `/compact` inspection. */
  readonly parts: readonly string[]
}

/**
 * Summarize a conversation by chunk-then-reduce.
 *
 * A failed chunk summary degrades to a placeholder rather than aborting: losing
 * one slice of history is strictly better than throwing away the whole
 * conversation because one request timed out.
 */
export async function compactChunked(
  messages: readonly ChunkableMessage[],
  options: ChunkedCompactionOptions,
): Promise<ChunkedCompactionResult> {
  const { pinned, rest } = splitPinned(messages)
  const chunks = chunkMessages(rest, options)
  const parts: string[] = []
  let done = 0
  for (const chunk of chunks) {
    let text: string
    try {
      text = await options.summarize(chunk, chunk.index)
    } catch {
      text = `[summary unavailable for messages ${chunk.index + 1}..${chunk.index + chunk.messages.length}]`
    }
    parts.push(text)
    done++
    options.onProgress?.(done, chunks.length)
  }
  // The pinned prefix is prepended UNCHANGED, then the reduced history follows.
  const pinnedText = pinned
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
    .join("\n")
  const reduced = reduceSummaries(parts, options.maxSummaryChars ?? 24_000)
  return {
    summary: pinnedText.length > 0 ? `${pinnedText}\n\n---\n${reduced}` : reduced,
    chunkCount: chunks.length,
    parts,
  }
}
