/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Shared-harness proof — the four loop paths every agent change must keep
 * green, exercised through the single `loop-test-harness` builder (no
 * copy-pasted providers): no-tool turn, tool-call turn, denial path, and
 * budget exhaustion. Each case asserts `providerCalls` so an unexpected
 * extra turn fails loudly instead of leaking budget silently.
 */

import { afterEach, describe, expect, it } from "vitest"
import { resetBudget, estimateTokens } from "../../../../packages/core/src/token_budget.js"
import type { AgentEvent } from "../../../../packages/protocol/src/index.js"
import {
  assertProviderCalls,
  assistantTexts,
  eventsOfType,
  makeScriptedProvider,
  probeTool,
  runTestLoop,
  testBaseConfig,
  textReply,
  toolReply,
  toolTexts,
} from "./loop-test-harness.js"

afterEach(() => {
  resetBudget()
})

const PER_TURN_TEXT = "hello world!"
const PER_TURN = estimateTokens(`${PER_TURN_TEXT}\n${JSON.stringify({ n: 1 })}`)

describe("loop-test-harness: no-tool turn", () => {
  it("ends after a single text turn with agent_end and no tool activity", async () => {
    const scripted = makeScriptedProvider([textReply("done")])

    const { events, messages, providerCalls } = await runTestLoop("go", testBaseConfig(), scripted)

    assertProviderCalls(providerCalls(), 1)
    expect(assistantTexts(messages).join("\n")).toContain("done")
    expect(toolTexts(messages)).toHaveLength(0)
    expect(events[events.length - 1]?.type).toBe("agent_end")
    expect(events.some((e) => e.type === "budget_exhausted")).toBe(false)
  })
})

describe("loop-test-harness: tool-call turn", () => {
  it("executes the tool and continues to the next turn", async () => {
    const executed: string[] = []
    const scripted = makeScriptedProvider([toolReply("c1", "probe", { n: 1 }), textReply("done")])

    const { events, messages, providerCalls } = await runTestLoop("go", testBaseConfig(), scripted, {
      tools: [probeTool("probe", executed)],
    })

    assertProviderCalls(providerCalls(), 2)
    expect(executed).toEqual(['{"n":1}'])
    expect(toolTexts(messages)).toContain("did:probe")
    expect(assistantTexts(messages).join("\n")).toContain("done")
    expect(events[events.length - 1]?.type).toBe("agent_end")
  })
})

describe("loop-test-harness: denial path", () => {
  it("blocks a rule-denied tool without asking and stays bounded", async () => {
    const executed: string[] = []
    const config = testBaseConfig({
      maxTurns: 2,
      permissions: {
        mode: "default",
        rules: [{ tool: "probe", pattern: "*", allow: false }],
        askByDefault: true,
      },
    })
    const scripted = makeScriptedProvider([toolReply("c1", "probe", { n: 1 }), textReply("done")])

    const { events, messages, providerCalls } = await runTestLoop("go", config, scripted, {
      tools: [probeTool("probe", executed)],
    })

    assertProviderCalls(providerCalls(), 2)
    expect(executed).toHaveLength(0)
    expect(toolTexts(messages).join("\n")).toContain("Trayambak permission denied for probe:")
    expect(eventsOfType(events, "permission_request")).toHaveLength(0) // deny never asks
  })
})

describe("loop-test-harness: budget exhaustion", () => {
  it("stops loudly with budget_exhausted + agent_end and bounded provider calls", async () => {
    let calls = 0
    const scripted = makeScriptedProvider([
      () => {
        calls += 1
        return {
          role: "assistant",
          content: [
            { type: "text", text: PER_TURN_TEXT },
            { type: "toolCall", id: `call-${calls}`, name: "ping", arguments: { n: 1 } },
          ],
          stopReason: "tool_use",
        }
      },
    ])

    const { events, providerCalls } = await runTestLoop(
      "go",
      testBaseConfig({ budget: "6 tokens", maxTurns: 50, maxToolCalls: 200, toolCallRate: 0 }),
      scripted,
    )

    // Two turns x PER_TURN charged >= 6 tokens, so the third turn never starts.
    assertProviderCalls(providerCalls(), 2)
    const exhausted = events.filter((e) => e.type === "budget_exhausted")
    expect(exhausted).toHaveLength(1)
    const payload = exhausted[0] as Extract<AgentEvent, { type: "budget_exhausted" }>
    expect(payload.used).toBe(2 * PER_TURN)
    expect(payload.max).toBe(6)
    const idx = events.indexOf(exhausted[0]!)
    expect(events.slice(idx).map((e) => e.type)).toEqual(["budget_exhausted", "agent_end"])
  }, 15000)
})

describe("loop-test-harness: assertProviderCalls", () => {
  it("throws a loud error on a count mismatch", () => {
    expect(() => assertProviderCalls(3, 2)).toThrow("providerCalls: expected 2 provider call(s), got 3")
    expect(() => assertProviderCalls(2, 2)).not.toThrow()
  })
})
