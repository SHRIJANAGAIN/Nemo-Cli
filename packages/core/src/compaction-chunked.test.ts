/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import {
  chunkMessages,
  compactChunked,
  reduceSummaries,
  splitPinned,
  type ChunkableMessage,
  type Chunk,
} from "./compaction-chunked.js"

function user(text: string): ChunkableMessage {
  return { role: "user", content: text }
}
function assistant(text: string): ChunkableMessage {
  return { role: "assistant", content: text }
}
/** An assistant turn that CALLS a tool. */
function call(id: string): ChunkableMessage {
  return { role: "assistant", content: `call ${id}`, toolCallId: id, hasToolCalls: true }
}
/** The tool result answering `call(id)`. */
function result(id: string): ChunkableMessage {
  return { role: "tool", content: `result ${id}`, toolCallId: id }
}

/** Every tool pair inside a chunk, to prove none was split. */
function orphanedIds(chunk: Chunk): string[] {
  const calls = new Set<string>()
  for (const message of chunk.messages) {
    if (!message.hasToolCalls) continue
    if (Array.isArray(message.toolCallIds)) for (const id of message.toolCallIds) calls.add(id)
    if (typeof message.toolCallId === "string") calls.add(message.toolCallId)
  }
  const orphans: string[] = []
  for (const message of chunk.messages) {
    if (message.role !== "tool") continue
    const id = message.toolCallId
    if (id !== undefined && !calls.has(id)) orphans.push(id)
  }
  return orphans
}

describe("splitPinned", () => {
  it("pins every system message plus the opening user turn", () => {
    const messages: ChunkableMessage[] = [
      { role: "system", content: "rules" },
      user("do the task"),
      assistant("ok"),
      user("more"),
    ]
    const { pinned, rest } = splitPinned(messages)
    expect(pinned.map((m) => m.role)).toEqual(["system", "user"])
    expect(rest.map((m) => m.role)).toEqual(["assistant", "user"])
  })

  it("keeps the opening user turn verbatim — the task must not be paraphrased", () => {
    const { pinned } = splitPinned([user("EXACT TASK TEXT"), assistant("done")])
    expect(pinned[0]?.content).toBe("EXACT TASK TEXT")
  })

  it("pins several leading system messages", () => {
    const messages: ChunkableMessage[] = [
      { role: "system", content: "a" },
      { role: "system", content: "b" },
      user("go"),
    ]
    expect(splitPinned(messages).pinned).toHaveLength(3)
  })

  it("pins nothing when the conversation opens with an assistant turn", () => {
    const { pinned, rest } = splitPinned([assistant("hm")])
    expect(pinned).toHaveLength(0)
    expect(rest).toHaveLength(1)
  })

  it("pins the task statement even when the session opens with an assistant turn", () => {
    // A resumed/continued session opens with a recap assistant turn and only
    // THEN the user's actual instruction. The instruction must survive into
    // the reduce step verbatim, not be paraphrased by a chunk summary.
    const { pinned, rest } = splitPinned([assistant("recap of where we were"), user("THE REAL TASK"), assistant("done")])
    expect(pinned.map((m) => m.content)).toEqual(["recap of where we were", "THE REAL TASK"])
    expect(rest.map((m) => m.content)).toEqual(["done"])
    expect(pinned[1]?.content).toBe("THE REAL TASK")
  })

  it("only pins the system prefix when no user message exists anywhere", () => {
    const { pinned, rest } = splitPinned([{ role: "system", content: "rules" }, assistant("a"), assistant("b")])
    expect(pinned.map((m) => m.role)).toEqual(["system"])
    expect(rest).toHaveLength(2)
  })

  it("stops at the FIRST user turn, not a later one", () => {
    const { rest } = splitPinned([user("first"), assistant("a"), user("second")])
    expect(rest.map((m) => m.content)).toEqual(["a", "second"])
  })

  it("handles an empty conversation", () => {
    expect(splitPinned([])).toEqual({ pinned: [], rest: [] })
  })
})

describe("chunkMessages", () => {
  it("returns one chunk when everything fits", () => {
    const chunks = chunkMessages([user("a"), assistant("b")], { maxChunkTokens: 1_000_000 })
    expect(chunks).toHaveLength(1)
  })

  it("never leaves a tool result without its call", () => {
    // The single most damaging failure: an orphan result is rejected by the
    // provider, or accepted and the transcript loses the call that produced it.
    const messages: ChunkableMessage[] = []
    for (let i = 0; i < 40; i++) messages.push(user(`pad ${i} ${"x".repeat(200)}`), assistant(`ack ${i}`))
    for (let i = 0; i < 10; i++) messages.push(call(`t${i}`), result(`t${i}`))
    const chunks = chunkMessages(messages, { maxChunkTokens: 400 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(orphanedIds(chunk)).toEqual([])
  })

  it("keeps a MULTI-call assistant message with all of its results", () => {
    // One assistant turn emitting several parallel calls, then the results. The
    // previous version tracked a single id, so it believed the group was resolved
    // after the first result and split the rest away from their calls.
    const messages: ChunkableMessage[] = [
      { role: "assistant", content: "parallel", hasToolCalls: true, toolCallIds: ["a", "b", "c"] },
      { role: "tool", content: "ra", toolCallId: "a" },
      { role: "tool", content: "rb", toolCallId: "b" },
      { role: "tool", content: "rc", toolCallId: "c" },
    ]
    const chunks = chunkMessages(messages, { maxChunkTokens: 1 })
    for (const chunk of chunks) expect(orphanedIds(chunk)).toEqual([])
  })

  it("does not orphan a call whose results arrive across a would-be boundary", () => {
    // Two calls in flight when the budget runs out, then both results.
    const messages: ChunkableMessage[] = [
      user(`pad ${"x".repeat(400)}`),
      { role: "assistant", content: "two", hasToolCalls: true, toolCallIds: ["p", "q"] },
      { role: "tool", content: "rp", toolCallId: "p" },
      { role: "tool", content: "rq", toolCallId: "q" },
      user("after"),
    ]
    const chunks = chunkMessages(messages, { maxChunkTokens: 50 })
    for (const chunk of chunks) expect(orphanedIds(chunk)).toEqual([])
    expect(chunks.flatMap((c) => c.messages)).toEqual(messages)
  })

  it("overruns the budget rather than orphan, when the two demands conflict", () => {
    // The invariant wins: an orphaned result is unrecoverable, an oversized chunk
    // is merely suboptimal.
    const messages: ChunkableMessage[] = [
      user(`filler ${"z".repeat(300)}`),
      { role: "assistant", content: "big", hasToolCalls: true, toolCallIds: ["z"] },
      { role: "tool", content: `huge result ${"y".repeat(600)}`, toolCallId: "z" },
    ]
    const chunks = chunkMessages(messages, { maxChunkTokens: 100 })
    for (const chunk of chunks) expect(orphanedIds(chunk)).toEqual([])
  })

  it("survives a call that never gets a result without dropping messages", () => {
    const messages: ChunkableMessage[] = [
      { role: "assistant", content: "dangling", hasToolCalls: true, toolCallIds: ["never"] },
      user("after"),
    ]
    const chunks = chunkMessages(messages, { maxChunkTokens: 1 })
    expect(chunks.flatMap((c) => c.messages)).toEqual(messages)
  })

  it("preserves every message across chunks — no silent loss", () => {
    const messages: ChunkableMessage[] = []
    for (let i = 0; i < 50; i++) messages.push(i % 2 === 0 ? user(`u${i}`) : assistant(`a${i}`))
    const chunks = chunkMessages(messages, { maxChunkTokens: 60 })
    expect(chunks.flatMap((c) => c.messages)).toEqual(messages)
  })

  it("numbers chunks and stamps the final total on each", () => {
    const messages = Array.from({ length: 20 }, (_, i) => user(`${i} ${"y".repeat(100)}`))
    const chunks = chunkMessages(messages, { maxChunkTokens: 100 })
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i))
    expect(chunks.every((c) => c.total === chunks.length)).toBe(true)
  })

  it("keeps one oversized message in its own chunk rather than dropping it", () => {
    const huge = user("z".repeat(50_000))
    const chunks = chunkMessages([huge], { maxChunkTokens: 10, hardCapTokens: 20 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.messages).toHaveLength(1)
  })

  it("reaches the hard cap instead of growing without bound", () => {
    const messages = Array.from({ length: 30 }, (_, i) => user(`${i} ${"q".repeat(500)}`))
    const chunks = chunkMessages(messages, { maxChunkTokens: 1_000, hardCapTokens: 1_200 })
    for (const chunk of chunks) expect(chunk.estimatedTokens).toBeLessThanOrEqual(1_200)
  })

  it("splits on token budget, not message count", () => {
    // Big and small messages must not land in equal-count, wildly unequal chunks.
    const messages: ChunkableMessage[] = [user("s".repeat(4_000)), ...Array.from({ length: 30 }, () => assistant("ok"))]
    const chunks = chunkMessages(messages, { maxChunkTokens: 500 })
    expect(chunks[0]?.messages).toHaveLength(1)
  })

  it("is deterministic — the same input gives the same split every run", () => {
    const messages = Array.from({ length: 40 }, (_, i) => user(`${i} ${"d".repeat(150)}`))
    expect(chunkMessages(messages, { maxChunkTokens: 300 })).toEqual(chunkMessages(messages, { maxChunkTokens: 300 }))
  })

  it("returns nothing for an empty conversation", () => {
    expect(chunkMessages([])).toEqual([])
  })

  it("accepts a custom estimator", () => {
    const chunks = chunkMessages([user("a"), user("b")], {
      maxChunkTokens: 1,
      estimate: () => 10,
    })
    expect(chunks).toHaveLength(2)
  })
})

describe("reduceSummaries", () => {
  it("keeps every summary when they all fit", () => {
    expect(reduceSummaries(["a", "b", "c"])).toBe("a\n\nb\n\nc")
  })

  it("drops the OLDEST summary first — recency is what gets acted on", () => {
    const out = reduceSummaries(["old", "new"], 6)
    expect(out).toBe("new")
  })

  it("always keeps the newest summary even when it alone exceeds the budget", () => {
    // Dropping everything would erase the most recent turns entirely.
    expect(reduceSummaries(["a", "huge summary"], 4)).toContain("huge summary")
  })

  it("is deterministic in what it keeps", () => {
    const summaries = ["1", "2", "3", "4", "5"]
    expect(reduceSummaries(summaries, 9)).toBe(reduceSummaries(summaries, 9))
  })

  it("handles no summaries at all", () => {
    expect(reduceSummaries([])).toBe("")
  })
})

describe("compactChunked", () => {
  const conversation: ChunkableMessage[] = [
    { role: "system", content: "SYSTEM RULES" },
    user("ORIGINAL TASK"),
    assistant("working"),
    user("more"),
    assistant("done"),
  ]

  it("summarizes each chunk separately and reduces them", async () => {
    const seen: number[] = []
    const result = await compactChunked(conversation, {
      maxChunkTokens: 5,
      summarize: async (chunk) => {
        seen.push(chunk.index)
        return `summary ${chunk.index}`
      },
    })
    expect(result.parts).toEqual(["summary 0", "summary 1"])
    expect(result.chunkCount).toBe(2)
    expect(seen).toEqual([0, 1])
  })

  it("carries the system prompt and original task through VERBATIM", async () => {
    // Paraphrasing the task is how an agent loses it.
    const result = await compactChunked(conversation, {
      maxChunkTokens: 5,
      summarize: async (chunk) => `PART${chunk.index}`,
    })
    expect(result.summary).toContain("SYSTEM RULES")
    expect(result.summary).toContain("ORIGINAL TASK")
    // The pinned prefix precedes the reduced history.
    expect(result.summary.indexOf("ORIGINAL TASK")).toBeLessThan(result.summary.indexOf("PART0"))
  })

  it("reports progress once per chunk", async () => {
    const seen: Array<[number, number]> = []
    await compactChunked(conversation, {
      maxChunkTokens: 5,
      summarize: async (chunk) => `s${chunk.index}`,
      onProgress: (done, total) => seen.push([done, total]),
    })
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ])
  })

  it("degrades one failed chunk to a placeholder instead of losing the session", async () => {
    const result = await compactChunked(conversation, {
      maxChunkTokens: 5,
      summarize: async (chunk) => {
        if (chunk.index === 1) throw new Error("provider timeout")
        return "good"
      },
    })
    expect(result.parts[0]).toBe("good")
    expect(result.parts[1]).toContain("summary unavailable")
    // The whole conversation is still summarized.
    expect(result.summary).toContain("ORIGINAL TASK")
  })

  it("produces a summary even when every chunk fails", async () => {
    const result = await compactChunked(conversation, {
      maxChunkTokens: 5,
      summarize: async () => {
        throw new Error("down")
      },
    })
    expect(result.parts).toHaveLength(2)
    expect(result.summary).toContain("ORIGINAL TASK")
  })

  it("handles a conversation that is only the pinned prefix", async () => {
    const result = await compactChunked([{ role: "system", content: "S" }, user("T")], {
      summarize: async () => "s",
    })
    expect(result.chunkCount).toBe(0)
    expect(result.summary).toContain("T")
  })

  it("handles an empty conversation without throwing", async () => {
    const result = await compactChunked([], { summarize: async () => "s" })
    expect(result.summary).toBe("")
    expect(result.chunkCount).toBe(0)
  })

  it("bounds the reduced output", async () => {
    const messages = Array.from({ length: 30 }, (_, i) => user(`${i} ${"w".repeat(200)}`))
    const result = await compactChunked([user("TASK"), ...messages], {
      maxChunkTokens: 100,
      maxSummaryChars: 200,
      summarize: async () => "x".repeat(120),
    })
    expect(result.summary.length).toBeLessThan(200 + 60)
  })
})
