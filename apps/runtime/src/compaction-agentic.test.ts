/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import type { AgentMessage, AssistantMessage } from "../../../packages/protocol/src/messages.js"
import type { ChatInput, Provider } from "../../../packages/provider/src/index.js"
import { DEFAULT_COMPACTION_POLICY, estimateMessages } from "./compaction.js"
import {
  agenticCompact,
  chooseSplit,
  EMPTY_DIGEST,
  mergeDigests,
  parseDigest,
  renderDigestMessage,
  renderTranscript,
  shouldUseAgenticCompaction,
  type AgenticCompactionOptions,
  type SessionDigest,
} from "./compaction-agentic.js"
import type { ChunkableMessage } from "../../../packages/core/src/compaction-chunked.js"

/* -- fixtures ----------------------------------------------------------- */

const user = (text: string): AgentMessage => ({ role: "user", content: text })
const assistant = (text: string): AgentMessage => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn" })
const toolResult = (toolName: string, text: string, isError = false): AgentMessage =>
  ({ role: "tool", toolCallId: `call_${toolName}`, toolName, isError, content: [{ type: "text", text }] }) as AgentMessage

/** An assistant message that opens `n` tool calls, followed by their results. */
function toolTurn(toolName: string, n = 1, output = "ok"): AgentMessage[] {
  const calls = Array.from({ length: n }, (_unused, i) => ({
    type: "toolCall" as const,
    id: `call_${toolName}_${i}`,
    name: toolName,
    arguments: { path: `file${i}.ts` },
  }))
  const msg: AssistantMessage = { role: "assistant", content: calls, stopReason: "tool_use" }
  // One result per call, answering the id that opens it.
  const results: AgentMessage[] = calls.map((c) => ({
    ...toolResult(toolName, `${output} for ${JSON.stringify(c.arguments)}`, false),
    toolCallId: c.id,
  }))
  return [msg as unknown as AgentMessage, ...results]
}

/**
 * A long conversation: task statement, then many tool turns with periodic
 * user follow-ups. The follow-ups matter — `chooseSplit` can only snap to a
 * USER boundary, so a fixture with a single user message has no head to
 * summarize and every agentic test would silently exercise the
 * deterministic path instead.
 */
function session(turns: number, outputSize = 400, everyUser = 5): AgentMessage[] {
  const messages: AgentMessage[] = [user("Fix the auth token leak in src/auth.ts")]
  for (let i = 0; i < turns; i++) {
    messages.push(...toolTurn("read_file", 1, "x".repeat(outputSize)))
    messages.push(assistant(`Step ${i}: read the file and noted the pattern.`))
    if (i % everyUser === everyUser - 1) messages.push(user(`continue with step ${i + 1}`))
  }
  return messages
}

/** Provider stub whose answer is fully controlled. */
function stubProvider(answer: string, opts: { throws?: boolean; empty?: boolean; capture?: ChatInput[] } = {}): Provider {
  return {
    id: "stub",
    async chat(input: ChatInput): Promise<AssistantMessage> {
      opts.capture?.push(input)
      if (opts.throws) throw new Error("provider exploded")
      const text = opts.empty ? "" : answer
      return { role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn" as const }
    },
  }
}

const OPTS = (): AgenticCompactionOptions => ({
  provider: stubProvider("<goal>fix leak</goal><facts>did work</facts>"),
  signal: undefined,
})

/**
 * A session large enough that the DETERMINISTIC engine also has work to do.
 *
 * The three fallback tests need this: they assert `changed === true`, which
 * only holds when the deterministic pass would have compacted anyway. On a
 * small session `compactMessages` correctly returns `changed: false` — nothing
 * needed doing — and asserting otherwise would be pinning a lie.
 */
function hugeSession(): AgentMessage[] {
  return session(400, 3_000)
}

const DIGEST_TEXT = [
  "<goal>Fix the auth token leak in src/auth.ts</goal>",
  "<facts>Read src/auth.ts, found the token in a query param, replaced it with a header.</facts>",
  "<files>",
  "src/auth.ts — edited",
  "src/session.ts — read",
  "</files>",
  "<errors>",
  "TS2345: Argument of type 'string' is not assignable to 'Header'",
  "</errors>",
  "<decisions>",
  "Used a header rather than a cookie to avoid changing the client",
  "</decisions>",
  "<todo>",
  "Run the auth tests",
  "</todo>",
].join("\n")

/* -- parseDigest -------------------------------------------------------- */

describe("parseDigest", () => {
  it("extracts every section", () => {
    const d = parseDigest(DIGEST_TEXT)
    expect(d.goal).toBe("Fix the auth token leak in src/auth.ts")
    expect(d.facts).toContain("query param")
    expect(d.files).toEqual(["src/auth.ts — edited", "src/session.ts — read"])
    expect(d.errors).toEqual(["TS2345: Argument of type 'string' is not assignable to 'Header'"])
    expect(d.decisions).toHaveLength(1)
    expect(d.todo).toEqual(["Run the auth tests"])
  })

  it("tolerates missing sections, wrong casing and stray bullets", () => {
    const d = parseDigest("<GOAL>\nship it\n</GOAL>\n<files>\n- a.ts — read\n* b.ts\n</FILES>")
    expect(d.goal).toBe("ship it")
    expect(d.files).toEqual(["a.ts — read", "b.ts"])
    expect(d.errors).toEqual([])
    expect(d.todo).toEqual([])
  })

  it("never throws on junk, empty or non-string input", () => {
    for (const junk of ["", "   ", "no tags here", "<goal>unclosed", "<<>>", null as unknown as string]) {
      const d = parseDigest(junk)
      expect(d.goal).toBe("")
      expect(Array.isArray(d.files)).toBe(true)
    }
  })

  it("dedupes case-insensitively but keeps the first spelling", () => {
    const d = parseDigest("<files>a.ts — read\na.ts — read\nA.TS — READ</files>")
    expect(d.files).toEqual(["a.ts — read"])
  })

  it("keeps distinct entries that differ by more than case", () => {
    const d = parseDigest("<files>a.ts — read\na.ts — edited</files>")
    expect(d.files).toEqual(["a.ts — read", "a.ts — edited"])
  })
})

/* -- mergeDigests ------------------------------------------------------- */

describe("mergeDigests", () => {
  it("unions lists and keeps the first goal", () => {
    const merged = mergeDigests([
      { ...EMPTY_DIGEST, goal: "first", files: ["a.ts"], errors: ["e1"] },
      { ...EMPTY_DIGEST, goal: "second", files: ["b.ts"], errors: ["e1"], todo: ["t"] },
    ])
    expect(merged.goal).toBe("first")
    expect(merged.files).toEqual(["a.ts", "b.ts"])
    expect(merged.errors).toEqual(["e1"])
    expect(merged.todo).toEqual(["t"])
  })

  it("handles an empty input list", () => {
    expect(mergeDigests([])).toEqual(EMPTY_DIGEST)
  })
})

/* -- renderTranscript --------------------------------------------------- */

describe("renderTranscript", () => {
  it("renders tool calls by name and result separately", () => {
    const text = renderTranscript([
      ...toolTurn("read_file", 1, "contents"),
      assistant("noted it"),
    ] as ChunkableMessage[])
    expect(text).toContain("read_file(")
    expect(text).toContain("tool result:")
    expect(text).toContain("assistant: noted it")
  })

  it("truncates a huge tool result instead of re-sending it", () => {
    const text = renderTranscript([toolResult("read_file", "y".repeat(50_000))] as ChunkableMessage[])
    expect(text.length).toBeLessThan(2_000)
    expect(text).toContain("…")
  })
})

/* -- renderDigestMessage ------------------------------------------------ */

describe("renderDigestMessage", () => {
  it("tags itself as machine-generated so the model cannot mistake it for the user", () => {
    const msg = renderDigestMessage(parseDigest(DIGEST_TEXT), 128_000) as { role: string; content: string }
    expect(msg.role).toBe("user")
    expect(msg.content).toContain("[internal:context-handoff]")
    expect(msg.content).toContain("GOAL:")
    expect(msg.content).toContain("REMAINING WORK:")
  })

  it("omits empty sections entirely", () => {
    const msg = renderDigestMessage({ ...EMPTY_DIGEST, goal: "g" }, 128_000) as { content: string }
    expect(msg.content).toContain("GOAL: g")
    expect(msg.content).not.toContain("FILES:")
    expect(msg.content).not.toContain("ERRORS SEEN:")
  })
})

/* -- chooseSplit -------------------------------------------------------- */

describe("chooseSplit", () => {
  it("snaps the boundary to a user message so tool pairing survives", () => {
    const messages: AgentMessage[] = [
      user("task"),
      ...toolTurn("read_file", 1, "x".repeat(500)),
      ...toolTurn("bash", 1, "y".repeat(500)),
      user("next task"),
      assistant("later"),
    ]
    const split = chooseSplit(messages, 100)
    expect(split.safe).toBe(true)
    expect(split.tail[0]!.role).toBe("user")
    expect(split.tail.length).toBeGreaterThan(0)
  })

  it("empties the head when the whole conversation is preserved", () => {
    // A budget larger than the session walks the boundary back to index 0.
    // That is a SAFE split (nothing is summarized), and the caller turns it
    // into the deterministic path because there is no head.
    const messages: AgentMessage[] = [user("only"), ...toolTurn("bash", 1), ...toolTurn("bash", 1)]
    const split = chooseSplit(messages, 10_000_000)
    expect(split.safe).toBe(true)
    expect(split.head).toEqual([])
    expect(split.tail).toEqual(messages)
  })

  it("returns an empty head for a single-user conversation", () => {
    const messages: AgentMessage[] = [user("hello"), assistant("hi")]
    expect(chooseSplit(messages, 10).head).toEqual([])
  })
})

/* -- pairing invariant under real splits -------------------------------- */

describe("pairing invariant", () => {
  it("never leaves a tool result whose assistant call was summarized away", () => {
    const messages = session(12, 600)
    for (const preserve of [0, 50, 500, 5_000, 50_000]) {
      const split = chooseSplit(messages, preserve)
      if (!split.safe) continue
      // First message of the tail must be a user message (never a tool result).
      expect(split.tail[0]!.role).toBe("user")
      // Every tool result in the tail must have its call somewhere in the tail.
      const called = new Set<string>()
      for (const m of split.tail) {
        if (m.role === "assistant" && Array.isArray(m.content)) {
          for (const p of m.content) {
            if (p != null && typeof p === "object" && (p as { type?: string }).type === "toolCall") {
              called.add((p as { id?: string }).id ?? "")
            }
          }
        }
      }
      for (const m of split.tail) {
        if (m.role !== "tool") continue
        const id = (m as { toolCallId?: string }).toolCallId
        if (id === undefined) continue
        expect(called.has(id)).toBe(true)
      }
    }
  })
})

/* -- agenticCompact ----------------------------------------------------- */

describe("agenticCompact", () => {
  it("produces a model digest and marks the strategy agentic", async () => {
    const messages = session(30, 900)
    const result = await agenticCompact(messages, DEFAULT_COMPACTION_POLICY, {
      provider: stubProvider(DIGEST_TEXT),
      preserveRecentTokens: 2_000,
      minAgenticTokens: 500,
    })

    expect(result.strategy).toBe("agentic")
    expect(result.digest?.goal).toContain("auth token leak")
    expect(result.changed).toBe(true)
    // The handoff carries the digest, and the task statement survives.
    const handoff = result.messages[0] as { role: string; content: string }
    expect(handoff.role).toBe("user")
    expect(handoff.content).toContain("[internal:context-handoff]")
    expect(result.messages.length).toBeLessThan(messages.length)
    expect(estimateMessages(result.messages)).toBeLessThan(estimateMessages(messages))
  })

  it("falls back to the deterministic marker when the provider throws", async () => {
    const messages = hugeSession()
    const result = await agenticCompact(messages, DEFAULT_COMPACTION_POLICY, {
      provider: stubProvider("", { throws: true }),
      preserveRecentTokens: 2_000,
      minAgenticTokens: 500,
    })
    // No model digest was produced — the deterministic engine answered.
    expect(result.strategy).toBe("agentic-failed")
    expect(result.digest).toBeUndefined()
    expect(result.changed).toBe(true)
    // And it actually freed the window, which is the whole point.
    expect(estimateMessages(result.messages)).toBeLessThan(estimateMessages(messages))
  })

  it("falls back when the provider returns an empty response", async () => {
    const messages = hugeSession()
    const result = await agenticCompact(messages, DEFAULT_COMPACTION_POLICY, {
      provider: stubProvider("", { empty: true }),
      preserveRecentTokens: 2_000,
      minAgenticTokens: 500,
    })
    expect(result.strategy).toBe("agentic-failed")
    expect(result.changed).toBe(true)
  })

  it("falls back when the summarizer returns unusable text", async () => {
    const messages = session(30, 900)
    const result = await agenticCompact(messages, DEFAULT_COMPACTION_POLICY, {
      provider: stubProvider(""),
      preserveRecentTokens: 2_000,
      minAgenticTokens: 500,
      reduce: async () => "no tags at all, just prose",
    })
    // Nothing parseable: the digest degrades to the raw text rather than
    // claiming structure it does not have.
    expect(result.strategy).toBe("agentic")
    expect(result.digest?.facts).toContain("no tags at all")
  })

  it("is a no-op when the head is too small to be worth a model call", async () => {
    const messages: AgentMessage[] = [user("task"), assistant("a"), user("again"), assistant("b")]
    const result = await agenticCompact(messages, DEFAULT_COMPACTION_POLICY, OPTS())
    expect(result.strategy).toBe("deterministic")
    expect(result.changed).toBe(false)
  })

  it("returns deterministic when there is no safe split (single user turn)", async () => {
    const messages: AgentMessage[] = [user("only"), ...toolTurn("bash", 3, "x".repeat(9_000))]
    const result = await agenticCompact(messages, DEFAULT_COMPACTION_POLICY, OPTS())
    expect(result.strategy).toBe("deterministic")
  })

  it("bails out immediately when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    let called = false
    const messages = hugeSession()
    const result = await agenticCompact(messages, DEFAULT_COMPACTION_POLICY, {
      provider: {
        id: "stub",
        chat: async () => {
          called = true
          return { role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "end_turn" as const }
        },
      },
      signal: controller.signal,
      preserveRecentTokens: 2_000,
      minAgenticTokens: 500,
    })
    expect(called).toBe(false)
    expect(result.strategy).toBe("agentic-failed")
    expect(result.changed).toBe(true)
  })

  it("guarantees the window fit even when the digest is enormous", async () => {
    const messages = session(40, 2_000)
    const result = await agenticCompact(messages, DEFAULT_COMPACTION_POLICY, {
      provider: stubProvider(`<goal>${"g".repeat(200_000)}</goal><facts>${"f".repeat(200_000)}</facts>`),
      preserveRecentTokens: 1_000,
      minAgenticTokens: 500,
    })
    expect(result.strategy).toBe("agentic")
    // Whatever the model said, the deterministic pass still makes it fit.
    expect(estimateMessages(result.messages)).toBeLessThanOrEqual(
      DEFAULT_COMPACTION_POLICY.contextWindowTokens - DEFAULT_COMPACTION_POLICY.completionReserveTokens,
    )
  })

  it("calls the provider once per chunk plus once for the reduce", async () => {
    const captured: ChatInput[] = []
    const messages = session(40, 2_000)
    const result = await agenticCompact(messages, DEFAULT_COMPACTION_POLICY, {
      provider: stubProvider(DIGEST_TEXT, { capture: captured }),
      preserveRecentTokens: 1_000,
      minAgenticTokens: 500,
    })
    expect(result.strategy).toBe("agentic")
    expect(result.chunkCount).toBeGreaterThan(0)
    expect(captured).toHaveLength(result.chunkCount! + 1)
    // The map prompt and the reduce prompt are different system prompts.
    expect(captured[0]!.system).not.toBe(captured[captured.length - 1]!.system)
  })

  it("never sends tools to the summarizer (no tool calls from a compactor)", async () => {
    const captured: ChatInput[] = []
    await agenticCompact(session(40, 2_000), DEFAULT_COMPACTION_POLICY, {
      provider: stubProvider(DIGEST_TEXT, { capture: captured }),
      preserveRecentTokens: 1_000,
      minAgenticTokens: 500,
    })
    for (const c of captured) expect(c.tools).toBeUndefined()
  })
})

/* -- shouldUseAgenticCompaction ---------------------------------------- */

describe("shouldUseAgenticCompaction", () => {
  it("is false below the trigger ratio", () => {
    expect(shouldUseAgenticCompaction(session(4, 200), DEFAULT_COMPACTION_POLICY, {})).toBe(false)
  })

  it("is true when the trigger fires and the head is large enough", () => {
    expect(
      shouldUseAgenticCompaction(session(60, 900), DEFAULT_COMPACTION_POLICY, {
        // A huge system prompt is what pushes the estimate over the trigger;
        // the head still has to clear the model-worthiness floor on its own.
        systemPrompt: "s".repeat(400_000),
        minAgenticTokens: 500,
      }),
    ).toBe(true)
  })

  it("is false when the whole conversation is the tail (no head to summarize)", () => {
    // No user follow-ups → no boundary → nothing to summarize.
    expect(
      shouldUseAgenticCompaction(session(20, 900, 10_000), DEFAULT_COMPACTION_POLICY, {
        systemPrompt: "s".repeat(400_000),
        minAgenticTokens: 500,
      }),
    ).toBe(false)
  })
})

/* -- no path breaks tool pairing --------------------------------------- */

describe("agentic compaction pairing", () => {
  it("every strategy keeps every tool result answered", async () => {
    const messages = session(25, 800)
    for (const provider of [stubProvider(DIGEST_TEXT), stubProvider("", { throws: true })]) {
      const result = await agenticCompact(messages, DEFAULT_COMPACTION_POLICY, {
        provider,
        preserveRecentTokens: 1_500,
        minAgenticTokens: 500,
      })
      const called = new Set<string>()
      for (const m of result.messages) {
        if (m.role === "assistant" && Array.isArray(m.content)) {
          for (const p of m.content) {
            if (p != null && typeof p === "object" && (p as { type?: string }).type === "toolCall") {
              called.add((p as { id?: string }).id ?? "")
            }
          }
        }
      }
      for (const m of result.messages) {
        if (m.role !== "tool") continue
        const id = (m as { toolCallId?: string }).toolCallId
        if (id === undefined) continue
        expect(called.has(id)).toBe(true)
      }
    }
  })
})

/* -- digest shape export ------------------------------------------------ */

describe("EMPTY_DIGEST", () => {
  it("is a neutral starting point", () => {
    const d: SessionDigest = EMPTY_DIGEST
    expect(d.goal).toBe("")
    expect(d.files).toEqual([])
  })
})
