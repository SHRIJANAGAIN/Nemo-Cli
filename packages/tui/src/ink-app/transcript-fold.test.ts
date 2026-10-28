/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import {
  foldTranscript,
  TRANSCRIPT_FOLD_KEEP_NEWEST_THINKING,
  TRANSCRIPT_FOLD_KEEP_NEWEST_TOOLS,
  TRANSCRIPT_SOFT_CAP_BYTES,
} from "./transcript-fold.js"
import type { NemoMessage } from "./types.js"

let n = 0
const tool = (content: string, over: Partial<NemoMessage> = {}): NemoMessage => ({
  id: `tool-${(n += 1)}`,
  timestamp: n,
  role: "tool",
  content,
  toolName: "bash",
  ...over,
})
const answer = (content: string, thinking = "", over: Partial<NemoMessage> = {}): NemoMessage => ({
  id: `msg-${(n += 1)}`,
  timestamp: n,
  role: "assistant",
  content,
  thinking,
  ...over,
})
const user = (content: string): NemoMessage => ({
  id: `u-${(n += 1)}`,
  timestamp: n,
  role: "user",
  content,
})
const big = (kb: number): string => "x".repeat(kb * 1024)

describe("foldTranscript", () => {
  it("returns the same reference when under the cap (no render churn)", () => {
    const messages = [user("hi"), answer("hello"), tool("ok")]
    expect(foldTranscript(messages)).toBe(messages)
  })

  it("returns the same reference for an empty transcript", () => {
    const messages: NemoMessage[] = []
    expect(foldTranscript(messages)).toBe(messages)
  })

  it("folds oldest tool outputs, keeps the newest intact", () => {
    const tools = Array.from({ length: TRANSCRIPT_FOLD_KEEP_NEWEST_TOOLS + 3 }, (_, i) =>
      tool(`output-${i}\n${big(200)}`),
    )
    const messages = [user("run it"), ...tools]
    const out = foldTranscript(messages)
    expect(out).not.toBe(messages)
    // Rows all survive — only content folds.
    expect(out.length).toBe(messages.length)
    // Oldest three folded with a marker; newest K byte-identical.
    for (let i = 1; i <= 3; i++) {
      expect(out[i]?.content).toContain("[output folded: showing")
      expect(out[i]?.content.length).toBeLessThan(10 * 1024)
    }
    for (let i = 4; i < out.length; i++) {
      expect(out[i]?.content).toBe(messages[i]?.content)
    }
  })

  it("folds the duplicated result on old tool-call rows too", () => {
    const calls = Array.from({ length: TRANSCRIPT_FOLD_KEEP_NEWEST_TOOLS + 2 }, (_, i) =>
      answer(JSON.stringify({ cmd: `echo ${i}` }), "", { toolCallId: `tc-${i}`, result: big(200) }),
    )
    const messages = [user("go"), ...calls]
    const out = foldTranscript(messages)
    expect(out[1]?.result).toContain("[output folded: showing")
    const newest = out[out.length - 1]
    expect(newest?.result).toBe(big(200))
  })

  it("drops stale thinking, keeps the newest reasoning", () => {
    const answers = Array.from({ length: TRANSCRIPT_FOLD_KEEP_NEWEST_THINKING + 2 }, (_, i) =>
      answer(`answer-${i}`, `reasoning-${i}\n${big(450)}`),
    )
    const messages = [user("think"), ...answers]
    const out = foldTranscript(messages)
    expect(out).not.toBe(messages)
    // Oldest reasoning gone, answer text untouched.
    expect(out[1]?.thinking).toBe("")
    expect(out[1]?.content).toBe("answer-0")
    const newest = out[out.length - 1]
    expect(newest?.thinking).toContain("reasoning-")
  })

  it("never folds user rows, no matter how big", () => {
    const messages = [user(big(2000)), tool(big(100))]
    const out = foldTranscript(messages)
    // 2MB+ total forces a fold pass, but the user row must survive intact.
    expect(out[0]?.content).toBe(messages[0]?.content)
    expect(out[0]?.content.length).toBeGreaterThan(TRANSCRIPT_SOFT_CAP_BYTES)
  })

  it("counts subagentPrompt toward the soft cap (retained card heap)", () => {
    // 9 x 100KB tool rows sit UNDER the 1.5MB cap on their own; the subagent
    // card's 1.6MB prompt is retained heap too, so the cap check must see it
    // and tip the pass — the oldest tool output then folds while the card's
    // own prompt stays intact (cards render it).
    const card = answer("subagent done", "", { subagentId: "s1", subagentPrompt: big(1600) })
    const tools = Array.from({ length: TRANSCRIPT_FOLD_KEEP_NEWEST_TOOLS + 1 }, (_, i) =>
      tool(`output-${i}\n${big(100)}`),
    )
    const messages = [user("run it"), card, ...tools]
    const out = foldTranscript(messages)
    expect(out).not.toBe(messages)
    expect(out[2]?.content).toContain("[output folded: showing")
    expect(out[1]?.subagentPrompt).toHaveLength(1600 * 1024)
  })

  it("is idempotent — a second pass changes nothing", () => {
    const tools = Array.from({ length: TRANSCRIPT_FOLD_KEEP_NEWEST_TOOLS + 3 }, (_, i) =>
      tool(`output-${i}\n${big(200)}`),
    )
    const once = foldTranscript([user("run it"), ...tools])
    expect(foldTranscript(once)).toBe(once)
  })
})
