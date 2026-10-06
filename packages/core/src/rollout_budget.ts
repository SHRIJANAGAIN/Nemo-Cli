/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Rollout Budget — token budget tracking across the session tree.
 *
 * Mirrors codex-rs/core/src/rollout_budget.rs in Rust.
 * Tracks token usage across the entire session tree and provides
 * budget reminders.
 */

/**
 * Token usage record for budget accounting. */
export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  codex_rollout_budget_units?: number
}

/**
 * Budget configuration.
 */
export interface RolloutBudgetConfig {
  /** Sampling token weight for budget calculation. */
  samplingTokenWeight: number
  /** Maximum budget in tokens (-1 for unlimited). */
  maxBudget: number
  /** Reminder interval in tokens. */
  reminderInterval: number
}

/**
 * Budget delivery record for a specific thread.
 */
export interface ThreadBudgetDelivery {
  windowId: string
  reminderIndex: number
}

/**
 * Budget reminder.
 */
export interface RolloutBudgetReminder {
  remainingTokens: number
  reminderIndex: number
}

/**
 * Rollout Budget — shared accounting for a session tree.
 *
 * Tracks weighted tokens used across all threads in a session,
 * provides budget reminders, and blocks further execution when
 * the budget is exhausted.
 */
/** Internal state for RolloutBudget. */
interface RolloutBudgetState {
  config: RolloutBudgetConfig
  weightedTokensUsed: number
  deliveries: Map<string, ThreadBudgetDelivery>
}

export class RolloutBudget {
  private static instance: RolloutBudget | null = null
  private state: RolloutBudgetState | null = null

  private constructor() {}

  /**
   * Get the singleton RolloutBudget instance.
   */
  static getInstance(): RolloutBudget {
    if (!RolloutBudget.instance) {
      RolloutBudget.instance = new RolloutBudget()
    }
    return RolloutBudget.instance
  }

  /**
   * Configure the budget with the given config.
   */
  configure(config: RolloutBudgetConfig): void {
    this.state = {
      config,
      weightedTokensUsed: 0,
      deliveries: new Map(),
    }
  }

  /**
   * Record token usage. Returns true if the budget is exhausted.
   */
  recordUsage(usage: TokenUsage): boolean {
    if (!this.state) return false

    const { config } = this.state

    const raw = usage.codex_rollout_budget_units ?? usage.output_tokens * config.samplingTokenWeight
    // Garbage usage must not poison the accumulator (#87): Math.max(0, NaN)
    // is NaN — one bad record would NaN weightedTokensUsed, and every later
    // `remaining <= 0` / exhaustion check would silently evaluate false
    // (fail-open budget). Non-finite records contribute 0; negatives stay
    // clamped to 0 (no rebate).
    const weighted = Number.isFinite(raw) ? Math.max(0, raw) : 0
    this.state.weightedTokensUsed += weighted

    const remaining = config.maxBudget >= 0 ? config.maxBudget - this.state.weightedTokensUsed : Infinity

    // Check if budget is exhausted
    if (remaining <= 0 && config.maxBudget >= 0) {
      return true
    }

    // Check if we should deliver a reminder
    const threshold = config.reminderInterval
    if (this.state.weightedTokensUsed % threshold < weighted) {
      // Deliver reminder to all threads
      return false
    }

    return false
  }

  /**
   * Get the remaining budget.
   */
  getRemaining(): number {
    if (!this.state || this.state.config.maxBudget < 0) return Infinity
    return Math.max(0, this.state.config.maxBudget - this.state.weightedTokensUsed)
  }

  /**
   * Get the total tokens used so far.
   */
  getUsed(): number {
    return this.state?.weightedTokensUsed ?? 0
  }

  /**
   * Check if the budget is configured and active.
   */
  isActive(): boolean {
    return this.state !== null && this.state.config.maxBudget >= 0
  }

  /**
   * Reset the budget.
   */
  reset(): void {
    this.state = null
  }
}

/**
 * Get the singleton RolloutBudget.
 */
export function getRolloutBudget(): RolloutBudget {
  return RolloutBudget.getInstance()
}

/**
 * Check if a turn should be blocked due to budget exhaustion.
 */
export function shouldBlockForBudget(): boolean {
  const budget = getRolloutBudget()
  if (!budget.isActive()) return false
  return budget.getRemaining() <= 0
}

/**
 * Record a turn's token usage against the budget.
 */
export function recordTurnUsage(
  inputTokens: number,
  outputTokens: number,
): { budgetExhausted: boolean; remaining: number } {
  const budget = getRolloutBudget()
  const usage: TokenUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  }
  const exhausted = budget.recordUsage(usage)
  return {
    budgetExhausted: exhausted,
    remaining: budget.getRemaining(),
  }
}
