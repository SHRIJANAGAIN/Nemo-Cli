/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import {
  foldTranscript,
  TRANSCRIPT_FOLD_KEEP_NEWEST_THINKING,
  TRANSCRIPT_FOLD_KEEP_NEWEST_TOOLS,
  TRANSCRIPT_SOFT_CAP_BYTES,
} from "./transcript-fold.js"
import type { TrayambakMessage } from "./types.js"

let n = 0
const tool = (content: string, over: Partial<TrayambakMessage> = {}): TrayambakMessage => ({
  id: `tool-${(n += 1)}`,
  timestamp: n,
  role: "tool",
  content,
  toolName: "bash",
  ...over,
})
const answer = (content: string, thinking = "", over: Partial<TrayambakMessage> = {}): TrayambakMessage => ({
  id: `msg-${(n += 1)}`,
  timestamp: n,
  role: "assistant",
  content,
  thinking,
  ...over,
})
const user = (content: string): TrayambakMessage => ({
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
    const messages: TrayambakMessage[] = []
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

  it("is idempotent — a second pass changes nothing", () => {
    const tools = Array.from({ length: TRANSCRIPT_FOLD_KEEP_NEWEST_TOOLS + 3 }, (_, i) =>
      tool(`output-${i}\n${big(200)}`),
    )
    const once = foldTranscript([user("run it"), ...tools])
    expect(foldTranscript(once)).toBe(once)
  })
})
