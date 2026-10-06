/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import type { AgentMessage, AssistantMessage, ToolResultMessage } from "../../../packages/protocol/src/messages.js"
import {
  compactMessages,
  estimateMessageTokens,
  estimateMessages,
  policyFromConfig,
  truncateText,
  DEFAULT_COMPACTION_POLICY,
  type CompactionPolicy,
} from "./compaction.js"

/** Every tool result must follow the assistant toolCall it answers, and
 * every toolCall must have a result — providers 400 on broken pairing. */
function assertPaired(msgs: AgentMessage[]): void {
  const pending = new Set<string>()
  for (const m of msgs) {
    if (m.role === "assistant") {
      for (const c of (m as AssistantMessage).content) {
        if (c.type === "toolCall") pending.add(c.id)
      }
    } else if (m.role === "tool") {
      const t = m as ToolResultMessage
      expect(pending.has(t.toolCallId), `orphan tool result ${t.toolCallId}`).toBe(true)
      pending.delete(t.toolCallId)
    }
  }
  expect([...pending], "toolCalls missing their results").toEqual([])
}

function user(content: string): AgentMessage {
  return { role: "user", content }
}

function assistantText(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn" }
}

function toolCallAssistant(id: string, name = "bash"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: { cmd: "ls" } }],
    stopReason: "tool_use",
  }
}

function toolResult(id: string, text: string, name = "bash"): ToolResultMessage {
  return { role: "tool", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false }
}

function policy(overrides: Partial<CompactionPolicy> = {}): CompactionPolicy {
  return { ...DEFAULT_COMPACTION_POLICY, ...overrides }
}

describe("estimateMessages", () => {
  it("scales with content and includes the system prompt", () => {
    const msgs = [user("a".repeat(4000))]
    const base = estimateMessages(msgs)
    const withSystem = estimateMessages(msgs, "s".repeat(4000))
    expect(base).toBeGreaterThanOrEqual(1000)
    expect(withSystem).toBeGreaterThan(base)
  })

  it("estimates corrupt persisted messages finitely so compaction stays armed (#88)", () => {
    // A non-string content used to yield NaN (or throw on a nameless
    // toolCall) — and a NaN total compares false against every threshold,
    // silently disabling compaction until the provider 400s on overflow.
    const corrupt = [
      { role: "user", content: { not: "a string" } },
      { role: "tool", content: [{ type: "text", text: 42 }] },
      { role: "assistant", content: [{ type: "toolCall", id: "1", arguments: {} }] },
      { role: "assistant", content: "not-an-array" },
      { role: "nonsense" },
      null,
    ] as unknown as AgentMessage[]
    for (const m of corrupt) {
      expect(Number.isFinite(estimateMessageTokens(m))).toBe(true)
    }
    expect(Number.isFinite(estimateMessages(corrupt))).toBe(true)
    // The trigger gate reads these totals — they must always be finite.
    const res = compactMessages(corrupt, policy(), { force: false })
    expect(Number.isFinite(res.estimatedBefore)).toBe(true)
    expect(Number.isFinite(res.estimatedAfter)).toBe(true)
  })
})

describe("truncateText", () => {
  it("is a no-op below the cap", () => {
    expect(truncateText("short", 100)).toBe("short")
  })
  it("keeps head and tail under the cap", () => {
    const out = truncateText("x".repeat(10_000), 1000)
    expect(out.length).toBeLessThanOrEqual(1100)
    expect(out).toContain("truncated")
    expect(out.startsWith("x")).toBe(true)
    expect(out.endsWith("x")).toBe(true)
  })
})

describe("compactMessages", () => {
  it("does nothing when comfortably under the window", () => {
    const msgs = [user("hello"), assistantText("hi there")]
    const res = compactMessages(msgs, policy(), {})
    expect(res.changed).toBe(false)
    expect(res.messages).toBe(msgs)
    expect(res.actions).toEqual([])
  })

  it("force runs even under the trigger ratio", () => {
    const msgs = [user("hello"), assistantText("hi")]
    const res = compactMessages(msgs, policy(), { force: true })
    expect(res.estimatedBefore).toBeGreaterThan(0)
    // Nothing eligible to cut → still reports unchanged.
    expect(res.changed).toBe(false)
  })

  it("truncates oversized head tool outputs but never the preserved tail", () => {
    const head: AgentMessage[] = [user("task"), toolCallAssistant("c1"), toolResult("c1", "B".repeat(50_000))]
    const tail: AgentMessage[] = []
    for (let i = 0; i < DEFAULT_COMPACTION_POLICY.preserveRecentMessages - 3; i++) {
      tail.push(user(`u${i}`), assistantText(`a${i}`))
    }
    tail.push(toolCallAssistant("c2"), toolResult("c2", "T".repeat(20_000)))
    const res = compactMessages([...head, ...tail], policy({ contextWindowTokens: 128_000 }), { force: true })

    const headTool = res.messages.find(
      (m) => m.role === "tool" && (m as ToolResultMessage).toolCallId === "c1",
    ) as ToolResultMessage
    const tailTool = res.messages.find(
      (m) => m.role === "tool" && (m as ToolResultMessage).toolCallId === "c2",
    ) as ToolResultMessage
    expect(headTool.content[0]!.text.length).toBeLessThanOrEqual(DEFAULT_COMPACTION_POLICY.toolOutputMaxChars + 120)
    expect(tailTool.content[0]!.text.length).toBe(20_000)
    expect(res.actions).toContain("truncate")
    expect(res.freedTokens).toBeGreaterThan(0)
    assertPaired(res.messages)
  })

  it("prunes old tool outputs only when the gain clears the minimum", () => {
    // ~60k tokens of old tool output: newest 40k protected → ~20k prunable,
    // which must beat pruneMinimumTokens (20k) — build 90k to be safe.
    const msgs: AgentMessage[] = [user("task")]
    for (let i = 0; i < 9; i++) {
      msgs.push(toolCallAssistant(`old${i}`), toolResult(`old${i}`, "P".repeat(40_000)))
    }
    msgs.push(assistantText("done"))
    // Small tail so most outputs sit outside the preserved tail and the
    // walk-back protect window (40k) can't swallow them all.
    const res = compactMessages(msgs, policy({ preserveRecentMessages: 4 }), { force: true })
    expect(res.actions).toContain("prune")
    expect(res.prunedToolOutputs).toBeGreaterThan(0)
    // The most recent outputs stay verbatim.
    const last = res.messages.find(
      (m) => m.role === "tool" && (m as ToolResultMessage).toolCallId === "old8",
    ) as ToolResultMessage
    expect(last.content[0]!.text.length).toBe(40_000)
    const prunedOne = res.messages.find(
      (m) => m.role === "tool" && (m as ToolResultMessage).toolCallId === "old0",
    ) as ToolResultMessage
    expect(prunedOne.content[0]!.text).toContain("pruned")
    assertPaired(res.messages)
  })

  it("never prunes protected tools", () => {
    const msgs: AgentMessage[] = [user("task")]
    for (let i = 0; i < 12; i++) {
      msgs.push(toolCallAssistant(`s${i}`, "skill"), toolResult(`s${i}`, "S".repeat(40_000), "skill"))
    }
    const res = compactMessages(msgs, policy(), { force: true })
    const anyPruned = res.messages.some(
      (m) =>
        m.role === "tool" &&
        (m as ToolResultMessage).toolName === "skill" &&
        (m as ToolResultMessage).content[0]!.text.includes("pruned"),
    )
    expect(anyPruned).toBe(false)
    expect(res.prunedToolOutputs).toBe(0)
  })

  it("drops the head on a user boundary with a marker, keeping pairing", () => {
    // Small window so stage 3 must fire.
    const msgs: AgentMessage[] = []
    msgs.push(user("original request"))
    for (let i = 0; i < 40; i++) {
      msgs.push(
        user(`ask ${i}`),
        toolCallAssistant(`t${i}`),
        toolResult(`t${i}`, "Z".repeat(8_000)),
        assistantText(`answer ${i}`),
      )
    }
    const res = compactMessages(
      msgs,
      policy({ contextWindowTokens: 8_000, completionReserveTokens: 1_024, preserveRecentMessages: 6 }),
      {
        force: true,
      },
    )

    expect(res.changed).toBe(true)
    expect(res.actions).toContain("drop")
    expect(res.removedMessages).toBeGreaterThan(0)
    expect(res.estimatedAfter).toBeLessThan(res.estimatedBefore)
    // The marker records the original ask.
    const marker = res.messages.find((m) => m.role === "user" && m.content.includes("auto-compaction"))
    expect(marker).toBeDefined()
    expect(marker!.content).toContain("original request")
    // Split happened on a user boundary → first non-marker kept message... pairing holds overall.
    assertPaired(res.messages)
    // Still over? Then 4c must have squeezed it under.
    expect(res.estimatedAfter).toBeLessThanOrEqual(8_000 - 1_024 + 4_000) // marker/rounding headroom
  })

  it("guarantees pairing survives forced compaction of a tool-heavy session", () => {
    const msgs: AgentMessage[] = [user("big task")]
    for (let i = 0; i < 30; i++) {
      msgs.push(
        toolCallAssistant(`h${i}`),
        toolResult(`h${i}`, "Q".repeat(12_000)),
        assistantText(`step ${i} " + "y".repeat(300)`),
      )
    }
    msgs.push(user("follow-up"))
    for (let i = 0; i < 10; i++) {
      msgs.push(toolCallAssistant(`f${i}`), toolResult(`f${i}`, "R".repeat(12_000)), assistantText(`fstep ${i}`))
    }
    const res = compactMessages(msgs, policy({ contextWindowTokens: 16_000, completionReserveTokens: 2_048 }), {
      force: true,
    })
    assertPaired(res.messages)
    expect(res.estimatedAfter).toBeLessThanOrEqual(res.estimatedBefore)
  })

  it("shrinks a single oversized message under a tiny window", () => {
    const msgs: AgentMessage[] = [user("Y".repeat(500_000))]
    const res = compactMessages(msgs, policy({ contextWindowTokens: 4_096, completionReserveTokens: 1_024 }), {
      force: true,
    })
    expect(res.changed).toBe(true)
    expect(res.estimatedAfter).toBeLessThanOrEqual(res.estimatedBefore)
    const kept = res.messages.find((m) => m.role === "user")
    expect(kept).toBeDefined()
    expect((kept as { content: string }).content.length).toBeLessThan(500_000)
  })
})

describe("policyFromConfig", () => {
  it("maps config values and falls back to defaults", () => {
    const p = policyFromConfig({ contextWindow: 200_000, maxTokens: 8_192 })
    expect(p.contextWindowTokens).toBe(200_000)
    expect(p.completionReserveTokens).toBe(8_192)
    const d = policyFromConfig({})
    expect(d.contextWindowTokens).toBe(DEFAULT_COMPACTION_POLICY.contextWindowTokens)
    expect(d.completionReserveTokens).toBe(DEFAULT_COMPACTION_POLICY.completionReserveTokens)
  })
})
