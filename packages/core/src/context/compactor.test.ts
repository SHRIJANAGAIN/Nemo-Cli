/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { ContextCompactor } from "./compactor.js"
import type { AgentMessage } from "../../../protocol/src/messages.js"

const user = (text: string): AgentMessage => ({ role: "user", content: text })

describe("ContextCompactor", () => {
  it("reports when the estimated size exceeds maxTokens", () => {
    const c = new ContextCompactor({ maxTokens: 10 })
    expect(c.needsCompaction([user("short")])).toBe(false)
    expect(c.needsCompaction([user("x".repeat(44))])).toBe(true)
    // estimates use ceil(chars / 4): 8 chars -> 2 tokens
    expect(c.needsCompaction([user("12345678")])).toBe(false)
    expect(c.needsCompaction([user("x".repeat(41))])).toBe(true) // ceil(41/4) = 11 > 10
  })

  it("estimates from assistant array content as well", () => {
    const c = new ContextCompactor({ maxTokens: 5 })
    const msg: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "a".repeat(21) }],
      stopReason: "end_turn",
    }
    expect(c.needsCompaction([msg])).toBe(true) // ceil(21/4) = 6 > 5
  })

  it("passes through conversations that fit within the reserved window", () => {
    const c = new ContextCompactor()
    const messages = Array.from({ length: 12 }, (_, i) => user(`m${i}`))
    const result = c.compact(messages)
    expect(result.messages).toBe(messages)
    expect(result.summary).toBe("")
    expect(result.removedCount).toBe(0)
  })

  it("keeps head and tail, summarizes the middle, and counts removals", () => {
    const c = new ContextCompactor()
    const messages = Array.from({ length: 20 }, (_, i) => user(`msg ${i}`))
    const result = c.compact(messages)

    expect(result.removedCount).toBe(8)
    expect(result.messages.length).toBe(13) // 4 head + 1 summary + 8 tail

    for (let i = 0; i < 4; i++) expect(result.messages[i]).toBe(messages[i])
    const summaryMsg = result.messages[4] as { role: string; content: string }
    expect(summaryMsg.role).toBe("system")
    expect(summaryMsg.content).toBe(`[CONTEXT COMPACTION — REFERENCE ONLY]\n\n${result.summary}\n\n[END COMPACTION]`)
    expect(result.summary.split("\n\n")).toEqual(Array.from({ length: 8 }, (_, i) => `USER: msg ${i + 4}`))
    for (let i = 0; i < 8; i++) expect(result.messages[5 + i]).toBe(messages[12 + i])
  })

  it("builds summaries from mixed roles, skipping empty text and slicing long text", () => {
    const c = new ContextCompactor()
    const messages: AgentMessage[] = [
      ...Array.from({ length: 4 }, (_, i) => user(`head ${i}`)),
      {
        role: "assistant",
        content: [
          { type: "text", text: "part one" },
          { type: "thinking", text: "internal thought" },
          { type: "toolCall", id: "t1", name: "read", arguments: {} },
        ],
        stopReason: "tool_use",
      },
      user(""), // contributes nothing to the summary
      user("x".repeat(600)), // sliced to 500 chars
      {
        role: "tool",
        toolCallId: "t1",
        toolName: "read",
        content: [{ type: "text", text: "tool output" }],
        isError: false,
      },
      ...Array.from({ length: 8 }, (_, i) => user(`tail ${i}`)),
    ]

    const result = c.compact(messages)
    expect(messages.length).toBe(16)
    expect(result.removedCount).toBe(4)
    expect(result.summary).toContain("ASSISTANT: part one")
    expect(result.summary).not.toContain("internal thought")
    expect(result.summary).not.toContain("toolCall")
    expect(result.summary).toContain("TOOL: tool output")
    expect(result.summary).toContain("x".repeat(500))
    expect(result.summary).not.toContain("x".repeat(501))
    // The empty user message contributes nothing: assistant, long user, tool.
    expect(result.summary.split("\n\n").length).toBe(3)
    expect(result.summary.startsWith("ASSISTANT: part one")).toBe(true)
    expect(result.summary.endsWith("TOOL: tool output")).toBe(true)
  })
})
