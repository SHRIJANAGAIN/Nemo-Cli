/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
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
  while (index < messages.length) {
    const message = messages[index]
    if (!message) break
    if (message.role === "system") {
      pinned.push(message)
      index++
      continue
    }
    // Include the opening user turn, then stop: later turns are history.
    if (pinned.some((m) => m.role === "user") === false && message.role === "user") {
      pinned.push(message)
      index++
    }
    break
  }
  return { pinned, rest: messages.slice(index) }
}

/**
 * True when `message` closes a tool pair that opened earlier in `seen`.
 *
 * A `tool_result` refers back to a `tool_call` by id. If the call is not already
 * inside the current chunk, the result must move with it — which is why the
 * chunker grows the previous chunk instead of splitting the pair.
 */
function closesOpenPair(message: ChunkableMessage, seenCallIds: ReadonlySet<string>): boolean {
  if (message.role !== "tool" && !message.toolCallId) return false
  if (message.role !== "tool") return false
  return message.toolCallId !== undefined && !seenCallIds.has(message.toolCallId)
}

/** True when this message OPENS a pair whose result has not arrived yet. */
function opensPair(message: ChunkableMessage): boolean {
  return message.hasToolCalls === true && typeof message.toolCallId === "string"
}

/**
 * Split into chunks that never break a tool pair.
 *
 * Greedy by token budget rather than fixed message counts, because message sizes
 * vary by three orders of magnitude (a one-line ack vs a pasted file) and a
 * count-based split would produce wildly uneven chunks.
 */
export function chunkMessages(messages: readonly ChunkableMessage[], options: ChunkOptions = {}): Chunk[] {
  const estimate = options.estimate ?? defaultEstimate
  const budget = options.maxChunkTokens ?? 8_000
  const hardCap = options.hardCapTokens ?? 24_000

  const chunks: Chunk[] = []
  let current: ChunkableMessage[] = []
  let currentTokens = 0
  /** Call ids opened inside the chunk being built. */
  let openCallIds = new Set<string>()

  const flush = (): void => {
    if (current.length === 0) return
    chunks.push({ index: chunks.length, total: 0, messages: current, estimatedTokens: currentTokens })
    current = []
    currentTokens = 0
    openCallIds = new Set()
  }

  for (const message of messages) {
    const size = estimate(message)

    // A tool RESULT whose call is not in this chunk belongs to the previous one:
    // push it back there rather than orphaning it.
    if (closesOpenPair(message, openCallIds) && current.length === 0 && chunks.length > 0) {
      const previous = chunks[chunks.length - 1]
      if (previous) {
        chunks[chunks.length - 1] = {
          ...previous,
          messages: [...previous.messages, message],
          estimatedTokens: previous.estimatedTokens + size,
        }
      }
      continue
    }

    // A call opens a pair; its result must land in the same chunk, so a chunk
    // holding an unresolved call is sealed rather than extended later.
    const hasUnresolvedCall = openCallIds.size > 0 && !message.toolCallId

    if (current.length > 0 && (currentTokens + size > budget || hasUnresolvedCall)) {
      flush()
    }
    // One message larger than the budget still gets its own chunk rather than
    // being dropped or split mid-JSON.
    current.push(message)
    currentTokens += size
    if (opensPair(message) && message.toolCallId) openCallIds.add(message.toolCallId)
    if (message.toolCallId && message.role === "tool") openCallIds.delete(message.toolCallId)
    if (currentTokens >= hardCap) flush()
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
