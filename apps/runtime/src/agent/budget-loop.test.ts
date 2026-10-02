/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import * as os from "node:os"
import { runAgentLoop } from "./agent-loop.js"
import { Session } from "../session/session.js"
import { loadConfig } from "../config.js"
import type { TrayambakConfig } from "../config.js"
import { getRolloutBudget } from "../../../../packages/core/src/rollout_budget.js"
import { estimateTokens, resetBudget } from "../../../../packages/core/src/token_budget.js"
import { textResult, type Tool } from "../tools/types.js"
import type { AgentEvent } from "../../../../packages/protocol/src/index.js"

/**
 * REAL loop enforcement for the rollout budget (AGENTS.md: "Budget
 * exhaustion stops the loop ... Never silently continue").
 *
 * Before this wiring, `shouldBlockForBudget()` was consulted nowhere in the
 * runtime loop — budgets were silently bypassed. These tests pin the three
 * behaviors that must never regress: (1) an exhausted budget stops the run
 * with an explicit signal and the provider stops being called, (b) an
 * unlimited/absent budget runs normally, (c) usage is recorded every turn,
 * (d) unparseable specs fall back with a warning instead of throwing.
 *
 * Usage accounting is ESTIMATED (ceil(chars/4)) — the provider protocol has
 * no usage fields — so expectations are computed with the same estimator.
 */

const PER_TURN_TEXT = "hello world!"
/** Estimated output tokens charged per turn (text + tool-arg JSON). */
const PER_TURN = estimateTokens(`${PER_TURN_TEXT}\n${JSON.stringify({ n: 1 })}`)

function baseConfig(overrides: Partial<TrayambakConfig>): TrayambakConfig {
  return {
    maxTurns: 50,
    maxRetries: 0,
    retryDelayMs: 50,
    maxToolCalls: 200,
    toolCallRate: 0,
    cwd: os.tmpdir(),
    permissions: { mode: "default", rules: [], askByDefault: false },
    ...overrides,
  } as unknown as TrayambakConfig
}

/** Provider that keeps emitting tool calls forever (varied args = no doom loop). */
function makeToolLoopProvider(): { provider: never; calls: () => number } {
  let calls = 0
  const provider = {
    chat: async () => {
      calls += 1
      return {
        role: "assistant",
        content: [
          { type: "text", text: PER_TURN_TEXT },
          { type: "toolCall", id: `call-${calls}`, name: "ping", arguments: { n: calls } },
        ],
        stopReason: "tool_use",
      }
    },
  } as never
  return { provider, calls: () => calls }
}

async function runLoop(
  config: TrayambakConfig,
  provider: never,
  tools: Tool[] = [],
): Promise<{ events: AgentEvent[]; messages: Awaited<ReturnType<typeof runAgentLoop>> }> {
  const session = new Session()
  const events: AgentEvent[] = []
  const messages = await runAgentLoop("go", {
    provider,
    tools,
    session,
    config,
    emit: async (e) => {
      events.push(e)
    },
  })
  return { events, messages }
}

afterEach(() => {
  resetBudget()
  vi.restoreAllMocks()
})

describe("runAgentLoop budget enforcement", () => {
  it("stops with budget_exhausted once the token budget runs out (bounded provider calls)", async () => {
    const { provider, calls } = makeToolLoopProvider()
    const { events, messages } = await runLoop(baseConfig({ budget: "6 tokens" }), provider)

    // Input is charged too (#64): turn 1 = 8 input tokens (the wire for
    // "go" = '[{"role":"user","content":"go"}]' = 32 chars → ceil/4) +
    // PER_TURN (5) output = 13 ≥ 6, so the second turn never starts.
    expect(calls()).toBe(1)
    expect(calls()).toBeLessThan(50) // bounded — nowhere near maxTurns
    expect(getRolloutBudget().getUsed()).toBe(8 + PER_TURN)

    const exhausted = events.filter((e) => e.type === "budget_exhausted")
    expect(exhausted).toHaveLength(1)
    const payload = exhausted[0] as Extract<AgentEvent, { type: "budget_exhausted" }>
    expect(payload.used).toBe(8 + PER_TURN)
    expect(payload.max).toBe(6)
    expect(payload.remaining).toBe(0)

    // The signal is followed by agent_end — never a silent cut.
    const idx = events.indexOf(exhausted[0])
    expect(events.slice(idx).map((e) => e.type)).toEqual(["budget_exhausted", "agent_end"])
    expect(messages.length).toBeGreaterThan(1)
    expect(events[events.length - 1]?.type).toBe("agent_end")
  }, 15000)

  it("stops at a turn budget without capping tokens", async () => {
    const { provider, calls } = makeToolLoopProvider()
    const { events } = await runLoop(baseConfig({ budget: "2 turns", maxTurns: 50 }), provider)

    expect(calls()).toBe(2)
    const payload = events.find((e) => e.type === "budget_exhausted") as
      Extract<AgentEvent, { type: "budget_exhausted" }> | undefined
    expect(payload).toBeDefined()
    expect(payload?.max).toBe(-1) // unlimited tokens — the turn cap ended it
    expect(payload?.remaining).toBe(0) // Infinity is not JSON-safe; clamped
    // (8+5) turn 1 + (63+5) turn 2: every turn charges its re-sent input (#64).
    expect(payload?.used).toBe(81)
  }, 15000)

  it("runs normally with a -1 (unlimited) budget", async () => {
    const { provider, calls } = makeToolLoopProvider()
    const { events } = await runLoop(baseConfig({ budget: "-1", maxTurns: 5 }), provider)

    expect(calls()).toBe(5) // only maxTurns bounds the run
    expect(events.some((e) => e.type === "budget_exhausted")).toBe(false)
    expect(events[events.length - 1]?.type).toBe("agent_end")
    expect(getRolloutBudget().isActive()).toBe(false) // -1 = unlimited
  }, 15000)

  it("runs normally when no budget is configured", async () => {
    const { provider, calls } = makeToolLoopProvider()
    const { events } = await runLoop(baseConfig({ maxTurns: 3 }), provider)

    expect(calls()).toBe(3)
    expect(events.some((e) => e.type === "budget_exhausted")).toBe(false)
    expect(events[events.length - 1]?.type).toBe("agent_end")
    expect(getRolloutBudget().isActive()).toBe(false)
  }, 15000)

  it("records estimated usage every turn while a budget is active", async () => {
    const { provider, calls } = makeToolLoopProvider()
    await runLoop(baseConfig({ budget: "1000 tokens", maxTurns: 3 }), provider)

    expect(calls()).toBe(3)
    const used = getRolloutBudget().getUsed()
    // (8+5) + (63+5) + (117+5): inputs grow with the re-sent context — the
    // denial-loop burn the token cap now sees (#64) — and stay under 1000.
    expect(used).toBe(203)
    expect(used).toBeGreaterThan(3 * PER_TURN)
    expect(getRolloutBudget().getRemaining()).toBe(1000 - 203)
  }, 15000)

  it("a permission-denial loop still trips the token budget (#64)", async () => {
    // The audit's doom-loop shape: every response calls a tool a deny rule
    // refuses, outputs stay tiny, and each retry re-sends the growing
    // context — output-only accounting never noticed this burn, charging
    // input does.
    let calls = 0
    const provider = {
      chat: async () => {
        calls += 1
        return {
          role: "assistant",
          content: [
            { type: "text", text: "retrying" },
            { type: "toolCall", id: `d-${calls}`, name: "probe", arguments: { n: calls } },
          ],
          stopReason: "tool_use",
        }
      },
    } as never
    const executed: string[] = []
    const denyProbe: Tool = {
      definition: {
        name: "probe",
        description: "test double",
        parameters: { type: "object", properties: {}, required: [] },
        timeoutMs: 10_000,
      },
      execute: async (_toolCallId, args) => {
        executed.push(JSON.stringify(args))
        return textResult("did:probe")
      },
    }
    const config = baseConfig({
      budget: "40 tokens",
      maxTurns: 50,
      permissions: { mode: "default", rules: [{ tool: "probe", pattern: "*", allow: false }], askByDefault: true },
    })
    const { events } = await runLoop(config, provider, [denyProbe])

    expect(executed).toHaveLength(0) // denied before execution, every turn
    // The budget stopped it — maxTurns (50) was never reached.
    expect(calls).toBeGreaterThanOrEqual(2) // looped, then tripped
    expect(calls).toBeLessThan(50)
    const exhausted = events.filter((e) => e.type === "budget_exhausted")
    expect(exhausted).toHaveLength(1)
    const payload = exhausted[0] as Extract<AgentEvent, { type: "budget_exhausted" }>
    expect(payload.max).toBe(40)
    // Tiny outputs (≈4-5 tokens/turn) alone could never reach 40 this fast
    // — the re-sent input is what got charged (#64).
    expect(payload.used).toBeGreaterThan(calls * PER_TURN)
  }, 15000)

  it("falls back to no budget when the spec cannot be parsed", async () => {
    const { provider, calls } = makeToolLoopProvider()
    const { events } = await runLoop(baseConfig({ budget: "free money", maxTurns: 2 }), provider)

    expect(calls()).toBe(2) // unbounded by budget — runs to maxTurns
    expect(events.some((e) => e.type === "budget_exhausted")).toBe(false)
    expect(getRolloutBudget().isActive()).toBe(false)
  }, 15000)
})

describe("budget config loading", () => {
  const savedBudget = process.env.TRAYAMBAK_BUDGET
  afterEach(() => {
    if (savedBudget === undefined) delete process.env.TRAYAMBAK_BUDGET
    else process.env.TRAYAMBAK_BUDGET = savedBudget
  })

  it("accepts valid specs from overrides", () => {
    expect(loadConfig({ budget: "50k" }).budget).toBe("50k")
    expect(loadConfig({ budget: "1.5M" }).budget).toBe("1.5M")
    expect(loadConfig({ budget: "40 turns" }).budget).toBe("40 turns")
    expect(loadConfig({ budget: "-1" }).budget).toBe("-1")
  })

  it("warns and falls back to no budget on an invalid spec (never throws)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const cfg = loadConfig({ budget: "lots of money" })
    expect(cfg.budget).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ignoring budget"))
  })

  it("reads TRAYAMBAK_BUDGET like TRAYAMBAK_MAX_TURNS", () => {
    process.env.TRAYAMBAK_BUDGET = "50k"
    expect(loadConfig().budget).toBe("50k")
  })
})
