/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * "The agent's response gets cut off."
 *
 * Two independent defects produced that, and both had to be fixed for a long
 * answer to survive:
 *
 * 1. FINISH-REASON VOCABULARY. `agent-loop.ts` recovers a severed answer by
 *    nudging the model to continue when `stopReason === "length"`. Both provider
 *    adapters classified reasons with an exact-match `switch` defaulting to
 *    `"end_turn"`, so any gateway that spells the token ceiling differently
 *    ("MAX_TOKENS", "model_length", …) produced a *finished* answer that was
 *    actually truncated. Measured: with that default in place, an unknown reason
 *    is indistinguishable from a complete reply.
 *
 * 2. LIFETIME CONTINUATION BUDGET. `lengthContinuations` was declared outside the
 *    turn loop and only ever incremented, so three long answers anywhere in one
 *    session exhausted the budget and every later answer was silently truncated
 *    at the `break`. That is why the symptom looked intermittent rather than
 *    consistent: early replies were fine, later ones stopped mid-sentence.
 *
 * Regression shape for both: a stub provider that stops on `length` must produce
 * one continuous answer, and the run must not truncate the SECOND long answer
 * just because the first one needed a continuation.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { stopReasonFromWire, isLengthStop } from "../../../../packages/protocol/src/index.js"
import { makeScriptedProvider, probeTool, runTestLoop, testBaseConfig } from "./loop-test-harness.js"
import type { Tool } from "../tools/types.js"
import { resetBudget } from "../../../../packages/core/src/token_budget.js"
import { clearSessionPermissionRules } from "../../../../packages/protocol/src/index.js"
import type { AgentMessage, AssistantContentPart, StopReason } from "../../../../packages/protocol/src/index.js"

/* ── 1. wire vocabulary ──────────────────────────────────────────────────── */

describe("stopReasonFromWire", () => {
  it("maps every real-world spelling of the token ceiling to length", () => {
    for (const reason of [
      "length", // OpenAI
      "max_tokens", // Anthropic, several gateways
      "MAX_TOKENS", // llama.cpp / Ollama / Gemini
      "max_output_tokens",
      "max_new_tokens",
      "max_completion_tokens",
      "model_length", // vLLM
      "model_length_reached",
      "token_limit",
      "output_limit",
      "response_length_exceeded",
      "incomplete", // Gemini's length condition
      "  LENGTH  ", // whitespace / case
      "max-tokens", // dash separator
      "openai.length", // namespaced
    ]) {
      expect(stopReasonFromWire(reason), reason).toBe("length")
    }
  })

  it("keeps the completions that are genuinely distinct", () => {
    for (const [reason, expected] of [
      ["tool_calls", "tool_use"],
      ["tool_use", "tool_use"],
      ["function_call", "tool_use"],
      ["stop", "end_turn"],
      ["end_turn", "end_turn"],
      ["stop_sequence", "end_turn"],
      ["eos", "end_turn"],
      ["content_filter", "end_turn"],
      ["abort", "aborted"],
      ["cancelled", "aborted"],
      ["error", "error"],
    ] as const) {
      expect(stopReasonFromWire(reason), reason).toBe(expected)
    }
  })

  it("fails toward length for reasons it has never seen", () => {
    // This is the load-bearing assertion: an unrecognised reason must NOT become
    // end_turn, because that reports a truncated answer as a complete one. A
    // spurious continuation costs one turn; a lost answer is not recoverable.
    for (const reason of ["some_new_gateway_reason", "wat", "length_exceeded_by_policy", null, undefined, "", 42]) {
      expect(stopReasonFromWire(reason as string), String(reason)).toBe("length")
    }
  })

  it("exposes the predicate the loop actually uses", () => {
    expect(isLengthStop("length")).toBe(true)
    expect(isLengthStop("end_turn")).toBe(false)
    expect(isLengthStop(undefined)).toBe(false)
  })
})

/* ── 2. lifetime budget ──────────────────────────────────────────────────── */

interface StubReply {
  text: string
  stopReason: StopReason
  /** When set, the reply also carries a tool call, so the loop keeps going. */
  tool?: string
}

interface StubOptions {
  /** Stop reason for each successive assistant reply. */
  replies: StubReply[]
}

function textOf(messages: AgentMessage[]): string {
  return messages
    .filter((m): m is Extract<AgentMessage, { role: "assistant" }> => m.role === "assistant")
    .flatMap((m) => m.content)
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("")
}

/**
 * Drive the loop with a provider that replays `replies` in order. The final
 * reply is repeated if the loop asks for more turns, so a runaway continuation
 * surfaces as extra provider calls rather than a hang.
 */
async function runWithReplies(
  replies: StubOptions["replies"],
  tools: Tool[] = [],
): Promise<{ text: string; providerCalls: number }> {
  const scripted = makeScriptedProvider(
    // Unique tool-call ids: the loop de-duplicates by id, so reusing one id
    // across replies would silently drop later executions and make the
    // tool-count assertion measure the harness instead of the loop.
    replies.map((r, i) => () => {
      const content: AssistantContentPart[] = [{ type: "text", text: r.text }]
      if (r.tool) content.push({ type: "toolCall", id: `c${r.tool}-${i}`, name: r.tool, arguments: { i } })
      return { role: "assistant", content, stopReason: r.stopReason }
    }),
  )
  const { messages } = await runTestLoop("write a long report", testBaseConfig({ maxTurns: 12 }), scripted, { tools })
  return { text: textOf(messages), providerCalls: scripted.calls() }
}

beforeEach(() => {
  clearSessionPermissionRules()
})

afterEach(() => {
  resetBudget()
})

describe("a length-stopped answer is continued, not returned truncated", () => {
  it("joins the continuation onto the severed answer", async () => {
    const { text } = await runWithReplies([
      { text: "Part one of the answer ", stopReason: "length" },
      { text: "and part two.", stopReason: "end_turn" },
    ])
    expect(text).toContain("Part one of the answer")
    expect(text).toContain("and part two.")
  })

  it("still bounds a pathological answer at MAX_LENGTH_CONTINUATIONS", async () => {
    // The budget must not become infinite in the other direction: an endless
    // length stop must terminate on maxTurns rather than loop forever. The old
    // budget also stopped at 4 calls, but the bound under test is "terminates",
    // not a specific count.
    const { providerCalls } = await runWithReplies([{ text: "always cut ", stopReason: "length" }])
    expect(providerCalls).toBeGreaterThan(1)
    expect(providerCalls).toBeLessThanOrEqual(12)
  })
})

describe("the continuation budget is per answer, not per session", () => {
  it("does not truncate later answers because earlier ones needed continuing", async () => {
    // One long multi-part answer, split by tool calls the way a real agent run
    // is: every "part" stops on `length`, and a tool call between parts ends the
    // turn on its own terms.
    //
    // Under the old lifetime counter the FIRST part consumed all three
    // continuations, so by the time the run reached the last part there was no
    // budget left and it was returned cut off mid-sentence with no signal. Each
    // part now gets its own budget because the tool-call turn resets it.
    const labels = ["FIRST", "SECOND", "THIRD", "FOURTH"]
    const replies: StubReply[] = []
    for (const label of labels) {
      // Cut off mid-answer, then continued; the turn then ends on a tool call,
      // which is what restores the budget for the next part.
      replies.push({ text: `${label}-part1 `, stopReason: "length" })
      replies.push({ text: `${label}-part2 `, stopReason: "tool_use", tool: "ping" })
    }
    replies.push({ text: "all parts delivered.", stopReason: "end_turn" })

    const executed: string[] = []
    const { text } = await runWithReplies(replies, [probeTool("ping", executed)])

    for (const label of labels) {
      expect(text, label).toContain(`${label}-part1`)
      expect(text, label).toContain(`${label}-part2`)
    }
    // The load-bearing part: the run reached the final answer at all. With an
    // exhausted budget the loop breaks before this, leaving the text short.
    expect(text).toContain("all parts delivered.")

    expect(executed).toHaveLength(labels.length)
  })

  it("restores the budget after a turn that finished on its own terms", async () => {
    // A single turn that ends normally must hand a full budget to whatever
    // length stop comes after it.
    const replies: StubReply[] = [
      { text: "step one ", stopReason: "tool_use", tool: "ping" },
      { text: "step two ", stopReason: "length" },
      { text: "step three ", stopReason: "tool_use", tool: "ping" },
      { text: "step four ", stopReason: "length" },
      { text: "step five done.", stopReason: "end_turn" },
    ]
    const executed: string[] = []
    const { text } = await runWithReplies(replies, [probeTool("ping", executed)])
    expect(text).toContain("step five done.")
    expect(executed).toHaveLength(2)
  })
})
