/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Token budget — budget parsing plus bounded turn continuation.
 *
 * Budgets arrive as specs: `50k`, `1.5M`, `50000`, `50000 tokens`,
 * `40 turns`, or `-1` (unlimited). `parseTokenBudget` returns a result
 * union instead of throwing: config rules say invalid values fall back
 * with a warning, so callers hand `{ok:false}` to the warning path.
 *
 * The parsed budget is applied to the shared `RolloutBudget` singleton
 * through its PUBLIC API only (that module is protected), and the helpers
 * here answer "may another turn run?" (`shouldContinueTurn`) so the agent
 * loop stops loudly instead of silently continuing past the cap.
 *
 * Dollar specs (`$5`, `10 usd`) are deliberately rejected: per-model
 * pricing tables are not wired into the runtime yet, so a dollar → token
 * conversion would invent precision we do not have. They come back as
 * `{ok:false}` with a reason that says exactly that.
 */

import { getRolloutBudget, shouldBlockForBudget } from "./rollout_budget.js"
import type { RolloutBudgetConfig } from "./rollout_budget.js"

/** A validated budget: a token cap, a turn cap, or unlimited tokens (-1). */
export type ParsedBudget = { kind: "tokens"; tokens: number } | { kind: "turns"; turns: number }

/** Result of `parseTokenBudget` — never throws, callers fall back on `ok:false`. */
export type ParseTokenBudgetResult = { ok: true; budget: ParsedBudget } | { ok: false; reason: string }

const UNIT_MULTIPLIERS: Record<string, number> = {
  "": 1,
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
}

/**
 * Parse a budget spec (`50k`, `1.5M`, `50000`, `50000 tokens`,
 * `40 turns`, `-1`). Numbers are token counts. Commas, underscores, and
 * spaces are tolerated. Garbage returns `{ok:false}` with a reason so the
 * caller can warn and fall back — it never throws. Zero (`0`, `0k`,
 * `0 turns`) is valid and means "run nothing": the loop refuses before the
 * first provider call instead of treating it as garbage (which used to fall
 * back to an unlimited run).
 */
export function parseTokenBudget(spec: string | number | undefined): ParseTokenBudgetResult {
  if (spec === undefined || spec === null) return { ok: false, reason: "no budget specified" }
  if (typeof spec === "number") {
    if (!Number.isFinite(spec)) return { ok: false, reason: "budget must be a finite number" }
    if (spec === -1) return { ok: true, budget: { kind: "tokens", tokens: -1 } }
    if (spec < 0) return { ok: false, reason: "budget must be positive (use -1 for unlimited)" }
    // Zero is a REAL budget, not garbage: it refuses before the first turn
    // (fail-closed). Rejecting it here used to fall back to NO budget with a
    // warning — an explicit "spend nothing" silently became "spend anything".
    return { ok: true, budget: { kind: "tokens", tokens: Math.floor(spec) } }
  }
  if (typeof spec !== "string") return { ok: false, reason: "budget must be a string or number" }

  const trimmed = spec.trim()
  if (trimmed === "") return { ok: false, reason: "budget is empty" }
  if (trimmed.includes("$") || /\busd\b|dollars?/i.test(trimmed)) {
    return {
      ok: false,
      reason:
        "dollar budgets are not supported yet (model pricing tables are not wired) — use a token count like '50k' or a turn count like '40 turns'",
    }
  }

  const text = trimmed.toLowerCase().replace(/[,_]/g, "")
  const match = /^(-?\d+(?:\.\d+)?)\s*(k|m|b|tokens?|turns?)?$/.exec(text)
  if (!match) {
    return {
      ok: false,
      reason: `cannot parse budget '${spec}' (expected e.g. '50k', '1.5M', '50000 tokens', '40 turns', or -1)`,
    }
  }
  const value = Number(match[1])
  if (!Number.isFinite(value)) return { ok: false, reason: `budget '${spec}' is not a finite number` }
  const unit = match[2] ?? ""
  if (value === -1 && unit === "") return { ok: true, budget: { kind: "tokens", tokens: -1 } }
  if (value < 0) return { ok: false, reason: "budget must be positive (use -1 for unlimited)" }
  if (unit === "turn" || unit === "turns") {
    const turns = Math.floor(value)
    return { ok: true, budget: { kind: "turns", turns } }
  }
  if (unit === "token" || unit === "tokens") {
    const tokens = Math.floor(value)
    return { ok: true, budget: { kind: "tokens", tokens } }
  }
  const tokens = Math.floor(value * (UNIT_MULTIPLIERS[unit] ?? 1))
  return { ok: true, budget: { kind: "tokens", tokens } }
}

/**
 * Documented token ESTIMATE — `ceil(chars / 4)`, the repo-wide convention
 * (compaction, TUI, session compaction). Provider responses carry no
 * usage/token fields, so every number derived from this is reported as
 * estimated, never as measured usage.
 */
export function estimateTokens(text: unknown): number {
  return Math.ceil(estimateTextChars(text) / 4)
}

/**
 * Char count for estimation, total over any payload (#88): a non-string
 * `content` made `text.length` undefined → NaN, which made every budget
 * threshold comparison false (budget silently never blocks). Circular-safe:
 * unserializable values fall back to `String()`.
 */
function estimateTextChars(text: unknown): number {
  if (typeof text === "string") return text.length
  if (text == null) return 0
  try {
    const json = JSON.stringify(text)
    return typeof json === "string" ? json.length : String(text).length
  } catch {
    return String(text).length
  }
}

/** Tunables forwarded to `RolloutBudget.configure()`. */
export interface RolloutBudgetDefaults {
  /** Weight applied to each estimated output token (1 = 1:1 accounting). */
  samplingTokenWeight: number
  /** Interval (in weighted units) between budget reminders. */
  reminderInterval: number
}

/** 1 estimated output token = 1 budget unit; reminders every 4k units. */
export const DEFAULT_ROLLOUT_BUDGET: RolloutBudgetDefaults = {
  samplingTokenWeight: 1,
  reminderInterval: 4_096,
}

/**
 * Map a parsed budget onto the `RolloutBudget` config shape. Turn budgets
 * have no token cap (`maxBudget: -1`, the module's "unlimited" sentinel);
 * their bound is enforced by `shouldContinueTurn()`.
 */
export function toRolloutBudgetConfig(
  parsed: ParsedBudget,
  defaults: RolloutBudgetDefaults = DEFAULT_ROLLOUT_BUDGET,
): RolloutBudgetConfig {
  return {
    samplingTokenWeight: defaults.samplingTokenWeight,
    reminderInterval: defaults.reminderInterval,
    maxBudget: parsed.kind === "tokens" ? parsed.tokens : -1,
  }
}

/** Config applied through `applyBudget()` — drives `budgetStatus().max`. */
let applied: RolloutBudgetConfig | null = null
/** Turn cap from a `{kind:"turns"}` budget; null when not applicable. */
let turnsLimit: number | null = null

/**
 * Apply a parsed budget to the shared `RolloutBudget` singleton (public
 * `configure()` API only). Re-applying the SAME config keeps cumulative
 * usage — a parent run plus its subagents share one rollout budget; a
 * different spec reconfigures (and therefore restarts) the accounting.
 */
export function applyBudget(parsed: ParsedBudget, defaults: RolloutBudgetDefaults = DEFAULT_ROLLOUT_BUDGET): void {
  const next = toRolloutBudgetConfig(parsed, defaults)
  turnsLimit = parsed.kind === "turns" ? parsed.turns : null
  const sameBudget =
    applied !== null &&
    getRolloutBudget().isActive() &&
    applied.maxBudget === next.maxBudget &&
    applied.samplingTokenWeight === next.samplingTokenWeight &&
    applied.reminderInterval === next.reminderInterval
  if (sameBudget) return
  applied = next
  getRolloutBudget().configure(next)
}

/** Drop any budget applied here and deactivate the singleton accounting. */
export function resetBudget(): void {
  applied = null
  turnsLimit = null
  getRolloutBudget().reset()
}

/** Snapshot of the active budget. `max: -1` means unlimited/unapplied. */
export interface BudgetStatus {
  /** Weighted units consumed (estimated output tokens × samplingTokenWeight). */
  used: number
  /** Units left; `Infinity` while the budget is unlimited or unconfigured. */
  remaining: number
  /** Configured cap; `-1` when unlimited or when no budget was applied here. */
  max: number
  /** True when another turn must NOT run. */
  exhausted: boolean
}

function overTurnLimit(turnsUsed: number | undefined): boolean {
  return turnsLimit !== null && turnsUsed !== undefined && turnsUsed > turnsLimit
}

/**
 * Used / remaining / exhausted for the active budget. Pass `turnsUsed`
 * (the current 1-based turn index at the top of a turn) to also evaluate
 * a turn budget.
 */
export function budgetStatus(turnsUsed?: number): BudgetStatus {
  const budget = getRolloutBudget()
  return {
    used: budget.getUsed(),
    remaining: budget.getRemaining(),
    max: applied ? applied.maxBudget : -1,
    exhausted: shouldBlockForBudget() || overTurnLimit(turnsUsed),
  }
}

/**
 * Bounded continuation: false once the token budget is exhausted or
 * `turnsUsed` exceeds a `{kind:"turns"}` budget (a `40 turns` budget
 * allows turns 1..40). Wraps `shouldBlockForBudget()` so the loop stops
 * LOUDLY (via its budget-exhausted signal) instead of silently continuing.
 */
export function shouldContinueTurn(turnsUsed?: number): boolean {
  if (overTurnLimit(turnsUsed)) return false
  return !shouldBlockForBudget()
}

export interface TurnBudgetState {
  readonly cap: number
  used: number
  turns: number
}

/**
 * Lightweight per-run token tracker (kept for callers that want local
 * accounting without the shared singleton). Token caps map onto `cap`;
 * turn budgets / unlimited / unparseable specs leave `cap` at 0, which
 * never exhausts — the shared singleton enforces those instead.
 */
export class TurnBudget {
  private readonly state: TurnBudgetState

  constructor(cap: string | number) {
    const parsed = parseTokenBudget(cap)
    const tokens = parsed.ok && parsed.budget.kind === "tokens" ? parsed.budget.tokens : 0
    this.state = { cap: tokens > 0 ? tokens : 0, used: 0, turns: 0 }
  }

  get cap(): number {
    return this.state.cap
  }

  get used(): number {
    return this.state.used
  }

  get turns(): number {
    return this.state.turns
  }

  remaining(): number {
    return Math.max(0, this.state.cap - this.state.used)
  }

  exhausted(): boolean {
    return this.state.cap > 0 && this.state.used >= this.state.cap
  }

  /** Record one turn's consumption. Negative/NaN counts as 0. */
  consume(tokens: number): void {
    const n = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0
    this.state.used += n
    this.state.turns += 1
  }

  /**
   * Bounded continuation: true while budget remains AND turns stay under
   * maxTurns. Either bound stops the loop — never silently continue.
   */
  shouldContinue(maxTurns: number): boolean {
    if (this.exhausted()) return false
    return this.state.turns < Math.max(1, Math.floor(maxTurns))
  }
}
