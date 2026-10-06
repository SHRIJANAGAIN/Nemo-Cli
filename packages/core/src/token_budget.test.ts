/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, describe, expect, it } from "vitest"
import {
  applyBudget,
  budgetStatus,
  DEFAULT_ROLLOUT_BUDGET,
  estimateTokens,
  parseTokenBudget,
  resetBudget,
  shouldContinueTurn,
  toRolloutBudgetConfig,
  TurnBudget,
} from "./token_budget.js"
import { getRolloutBudget, shouldBlockForBudget } from "./rollout_budget.js"

describe("token_budget parseTokenBudget", () => {
  it("parses human token budgets", () => {
    expect(parseTokenBudget("50k")).toEqual({ ok: true, budget: { kind: "tokens", tokens: 50_000 } })
    expect(parseTokenBudget("1.5M")).toEqual({ ok: true, budget: { kind: "tokens", tokens: 1_500_000 } })
    expect(parseTokenBudget("2b")).toEqual({ ok: true, budget: { kind: "tokens", tokens: 2_000_000_000 } })
    expect(parseTokenBudget("50000")).toEqual({ ok: true, budget: { kind: "tokens", tokens: 50_000 } })
    expect(parseTokenBudget("50000 tokens")).toEqual({ ok: true, budget: { kind: "tokens", tokens: 50_000 } })
    expect(parseTokenBudget("1,000")).toEqual({ ok: true, budget: { kind: "tokens", tokens: 1_000 } })
    expect(parseTokenBudget(500)).toEqual({ ok: true, budget: { kind: "tokens", tokens: 500 } })
  })

  it("parses turn budgets", () => {
    expect(parseTokenBudget("40 turns")).toEqual({ ok: true, budget: { kind: "turns", turns: 40 } })
    expect(parseTokenBudget("3 turn")).toEqual({ ok: true, budget: { kind: "turns", turns: 3 } })
    expect(parseTokenBudget("7turns")).toEqual({ ok: true, budget: { kind: "turns", turns: 7 } })
  })

  it("accepts -1 as explicit unlimited", () => {
    expect(parseTokenBudget(-1)).toEqual({ ok: true, budget: { kind: "tokens", tokens: -1 } })
    expect(parseTokenBudget("-1")).toEqual({ ok: true, budget: { kind: "tokens", tokens: -1 } })
  })

  it("rejects garbage with a reason instead of throwing", () => {
    for (const bad of [undefined, "", "   ", "lots", "-5k", "0", "0 tokens", "0 turns", "2.5 turns?"]) {
      const result = parseTokenBudget(bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0)
    }
    expect(parseTokenBudget(Number.NaN).ok).toBe(false)
    expect(parseTokenBudget(Number.POSITIVE_INFINITY).ok).toBe(false)
  })

  it("rejects dollar budgets and says pricing is not wired", () => {
    const result = parseTokenBudget("$5")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("pricing")
      expect(result.reason).toMatch(/50k/)
    }
    expect(parseTokenBudget("10 usd").ok).toBe(false)
    expect(parseTokenBudget("5 dollars").ok).toBe(false)
  })
})

describe("token_budget rollout config plumbing", () => {
  afterEach(() => {
    resetBudget()
  })

  it("maps parsed budgets onto RolloutBudgetConfig", () => {
    const parsed = parseTokenBudget("50k")
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(toRolloutBudgetConfig(parsed.budget, DEFAULT_ROLLOUT_BUDGET)).toEqual({
      samplingTokenWeight: 1,
      reminderInterval: 4_096,
      maxBudget: 50_000,
    })
    const turns = parseTokenBudget("40 turns")
    expect(turns.ok).toBe(true)
    if (!turns.ok) return
    // Turn budgets have no token cap — the sentinel is -1 (unlimited).
    expect(toRolloutBudgetConfig(turns.budget).maxBudget).toBe(-1)
  })

  it("applyBudget activates the singleton; usage drives exhaustion", () => {
    const parsed = parseTokenBudget("10 tokens")
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(shouldBlockForBudget()).toBe(false)
    applyBudget(parsed.budget)
    expect(getRolloutBudget().isActive()).toBe(true)
    expect(budgetStatus()).toEqual({ used: 0, remaining: 10, max: 10, exhausted: false })

    getRolloutBudget().recordUsage({ input_tokens: 4, output_tokens: 10 })
    const status = budgetStatus()
    expect(status.used).toBe(10)
    expect(status.remaining).toBe(0)
    expect(status.max).toBe(10)
    expect(status.exhausted).toBe(true)
    expect(shouldBlockForBudget()).toBe(true)
    expect(shouldContinueTurn(1)).toBe(false)
  })

  it("keeps cumulative usage when the same spec is re-applied", () => {
    const parsed = parseTokenBudget("100 tokens")
    if (!parsed.ok) throw new Error("spec must parse")
    applyBudget(parsed.budget)
    getRolloutBudget().recordUsage({ input_tokens: 0, output_tokens: 7 })
    applyBudget(parsed.budget) // same spec (parent + subagent runs share one budget)
    expect(getRolloutBudget().getUsed()).toBe(7)
    // A DIFFERENT spec reconfigures and restarts accounting.
    const other = parseTokenBudget("200 tokens")
    if (!other.ok) throw new Error("spec must parse")
    applyBudget(other.budget)
    expect(getRolloutBudget().getUsed()).toBe(0)
    expect(budgetStatus().max).toBe(200)
  })

  it("turn budgets bound shouldContinueTurn but not the token accounting", () => {
    const parsed = parseTokenBudget("2 turns")
    if (!parsed.ok) throw new Error("spec must parse")
    applyBudget(parsed.budget)
    expect(shouldBlockForBudget()).toBe(false) // no token cap
    expect(shouldContinueTurn(1)).toBe(true)
    expect(shouldContinueTurn(2)).toBe(true)
    expect(shouldContinueTurn(3)).toBe(false)
    const status = budgetStatus(3)
    expect(status.exhausted).toBe(true)
    expect(status.max).toBe(-1)
  })

  it("resetBudget deactivates accounting", () => {
    const parsed = parseTokenBudget("10 tokens")
    if (!parsed.ok) throw new Error("spec must parse")
    applyBudget(parsed.budget)
    getRolloutBudget().recordUsage({ input_tokens: 0, output_tokens: 10 })
    expect(shouldBlockForBudget()).toBe(true)
    resetBudget()
    expect(getRolloutBudget().isActive()).toBe(false)
    expect(shouldBlockForBudget()).toBe(false)
    expect(budgetStatus()).toEqual({ used: 0, remaining: Infinity, max: -1, exhausted: false })
    expect(shouldContinueTurn(1)).toBe(true)
  })

  it("unlimited budgets never block", () => {
    const parsed = parseTokenBudget("-1")
    if (!parsed.ok) throw new Error("spec must parse")
    applyBudget(parsed.budget)
    getRolloutBudget().recordUsage({ input_tokens: 0, output_tokens: 1_000_000 })
    expect(shouldBlockForBudget()).toBe(false)
    expect(shouldContinueTurn(1)).toBe(true)
    expect(budgetStatus()).toEqual({ used: 1_000_000, remaining: Infinity, max: -1, exhausted: false })
  })
})

describe("token_budget estimator", () => {
  it("estimateTokens is ceil(chars / 4)", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("1234")).toBe(1)
    expect(estimateTokens("12345")).toBe(2)
  })

  it("estimateTokens coerces non-string payloads to a finite count (#88)", () => {
    // `.length` on a non-string was undefined → NaN, which made every
    // budget threshold comparison false (the budget silently never blocks).
    expect(estimateTokens(undefined)).toBe(0)
    expect(estimateTokens(null)).toBe(0)
    expect(Number.isFinite(estimateTokens({ content: "hello" }))).toBe(true)
    expect(estimateTokens({ content: "hello" })).toBeGreaterThan(0)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(Number.isFinite(estimateTokens(circular))).toBe(true)
  })
})

describe("recordUsage garbage hardening (#87)", () => {
  it("skips non-finite usage instead of NaN-poisoning the budget", () => {
    const parsed = parseTokenBudget("100 tokens")
    if (!parsed.ok) throw new Error("spec must parse")
    applyBudget(parsed.budget)
    // Math.max(0, NaN) is NaN: one bad record used to NaN the accumulator,
    // after which every exhaustion/remainder check compared false — the
    // budget stopped enforcing itself without saying so (fail-open).
    getRolloutBudget().recordUsage({ input_tokens: NaN, output_tokens: NaN, codex_rollout_budget_units: NaN })
    getRolloutBudget().recordUsage({ input_tokens: 0, output_tokens: Infinity })
    // Negative usage clamps to 0 (no rebate), never contributes.
    getRolloutBudget().recordUsage({ input_tokens: 0, output_tokens: -50 })
    expect(budgetStatus()).toEqual({ used: 0, remaining: 100, max: 100, exhausted: false })
    // Finite usage AFTER garbage must still drive the budget to its cap.
    getRolloutBudget().recordUsage({ input_tokens: 0, output_tokens: 0, codex_rollout_budget_units: 100 })
    expect(budgetStatus().exhausted).toBe(true)
  })
})

describe("token_budget TurnBudget", () => {
  it("tracks consumption and exhaustion", () => {
    const budget = new TurnBudget("10k")
    expect(budget.remaining()).toBe(10_000)
    expect(budget.exhausted()).toBe(false)
    budget.consume(9_999)
    expect(budget.shouldContinue(64)).toBe(true)
    budget.consume(1)
    expect(budget.exhausted()).toBe(true)
    expect(budget.shouldContinue(64)).toBe(false)
    expect(budget.turns).toBe(2)
  })

  it("bounds turns even with budget left", () => {
    const budget = new TurnBudget("1M")
    budget.consume(10)
    expect(budget.shouldContinue(1)).toBe(false)
    expect(budget.shouldContinue(2)).toBe(true)
  })

  it("zero/turn-based/unparseable caps never exhaust", () => {
    expect(new TurnBudget(0).exhausted()).toBe(false)
    expect(new TurnBudget("40 turns").cap).toBe(0)
    expect(new TurnBudget("lots").cap).toBe(0)
    const budget = new TurnBudget(0)
    budget.consume(1_000_000)
    expect(budget.shouldContinue(64)).toBe(true)
  })
})
