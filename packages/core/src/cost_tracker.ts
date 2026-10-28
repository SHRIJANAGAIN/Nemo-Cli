/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Per-model pricing and cost estimation.
 *
 * A real gap: `recordModelUsage` estimated tokens on every turn but nothing ever
 * converted them to money, so `/stats` could tell a user how much they had
 * spent on tokens without telling them what that cost. Users budget in currency.
 *
 * The pricing table is DATA and deliberately conservative:
 *
 *  - **USD per million tokens.** The unit every provider publishes, so a row can
 *    be checked against a pricing page in one glance.
 *  - **Output is priced separately and higher**, because that is how every
 *    provider actually charges. Collapsing them into one "blended" number is how
 *    cost estimates end up wrong by 5x.
 *  - **Cached input is cheaper than fresh input.** Providers bill cache reads at
 *    a fraction. A tool-heavy session re-sends the same system prompt every turn,
 *    so ignoring cache pricing overstates cost substantially.
 *  - **Unknown models are NOT guessed.** `estimateCost` returns `undefined` for a
 *    model with no row, so a caller can say "unknown" instead of printing a
 *    confident wrong number. A cost display that silently invents a price is
 *    worse than one that admits ignorance.
 */

export interface ModelPrice {
  /** Provider id as used in config (`openai`, `anthropic`, …). */
  provider: string
  /** Model id exactly as sent on the wire. */
  model: string
  /** USD per million INPUT tokens. */
  inputPerMillion: number
  /** USD per million OUTPUT tokens. */
  outputPerMillion: number
  /** USD per million CACHED-INPUT tokens, when the provider bills them. */
  cachedInputPerMillion?: number
  /** USD per million REASONING tokens, when billed apart from output. */
  reasoningPerMillion?: number
  /** Context window in tokens, for the overflow warning. */
  contextWindow?: number
  /** Source the row was transcribed from, so a stale price is traceable. */
  source?: string
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /** Cache-read portion of `inputTokens`. Must be ≤ inputTokens. */
  cachedInputTokens?: number
  /** Reasoning portion of `outputTokens`. Must be ≤ outputTokens. */
  reasoningTokens?: number
}

export interface CostEstimate {
  provider: string
  model: string
  inputUsd: number
  outputUsd: number
  cachedInputUsd: number
  reasoningUsd: number
  /** Sum of every component, in USD. */
  totalUsd: number
  /** True when the model had no price row and the numbers are omitted. */
  unknownModel: boolean
  /** Fraction of input that was served from cache, 0..1. */
  cacheHitRate: number
}

/**
 * Pricing table.
 *
 * Keys are `provider/model` lowercased. Lookup normalises the case and tolerates
 * a provider-qualified model id (`openai/gpt-4o`), because that spelling reaches
 * the agent through gateway configs and OpenRouter-style ids.
 */
export const MODEL_PRICES: readonly ModelPrice[] = [
  // ── NVIDIA (the hosted backend) ─────────────────────────────────────────
  { provider: "nvidia", model: "nvidia/nemotron-3-super-120b-a12b", inputPerMillion: 0.6, outputPerMillion: 1.8, contextWindow: 131_072 },

  // ── Local runtimes: free, but recorded so a local run is distinguishable ──
  { provider: "llamacpp", model: "local", inputPerMillion: 0, outputPerMillion: 0, contextWindow: 32_768, source: "local inference" },
  { provider: "ollama", model: "local", inputPerMillion: 0, outputPerMillion: 0, contextWindow: 32_768, source: "local inference" },
]

const BY_KEY = new Map<string, ModelPrice>(
  MODEL_PRICES.map((price) => [`${price.provider}/${price.model}`.toLowerCase(), price]),
)

/** Local providers cost nothing; a cost report must say so rather than omit. */
export const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(["llamacpp", "ollama"])

/**
 * Find a price row.
 *
 * Lookup order, most specific first:
 *  1. `provider/model` exactly (case-insensitive)
 *  2. the model id alone, when it is unambiguous across the table
 *  3. a `provider/`-prefixed model id matched against the bare id
 */
export function findPrice(provider: string, model: string): ModelPrice | undefined {
  const p = provider.toLowerCase()
  const m = model.toLowerCase()

  const direct = BY_KEY.get(`${p}/${m}`)
  if (direct !== undefined) return direct

  // Gateway-qualified id: `openai/gpt-4o` with provider `openrouter`.
  const slash = m.indexOf("/")
  if (slash > 0) {
    const bare = m.slice(slash + 1)
    const qualified = BY_KEY.get(`${m.slice(0, slash)}/${bare}`)
    if (qualified !== undefined) return qualified
  }

  // Bare id across every provider: only accept it when exactly one row claims
  // it, so `llama-3.3-70b-versatile` (Groq) never silently takes Together's price.
  const candidates = MODEL_PRICES.filter((price) => price.model.toLowerCase() === m)
  if (candidates.length === 1) return candidates[0]
  return undefined
}

/** Clamp a possibly-hostile token count to a sane non-negative finite number. */
function sane(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

function usd(tokens: number, perMillion: number): number {
  return (tokens / 1_000_000) * perMillion
}

/**
 * Estimate the USD cost of one call.
 *
 * Returns `unknownModel: true` with zeroed components when no row matched — the
 * caller is expected to surface that as "unknown", not as "$0.00".
 *
 * Cached and reasoning tokens are SUBTRACTED from the input/output they are a
 * part of, so they are never billed twice. That matters: a long session's cache
 * reads are a large share of input, and charging them at the full input rate is
 * the single biggest way a cost estimate overshoots.
 */
export function estimateCost(provider: string, model: string, usage: TokenUsage): CostEstimate {
  const price = findPrice(provider, model)
  const input = sane(usage.inputTokens)
  const output = sane(usage.outputTokens)
  // Clamp to the parent: a provider reporting cache reads larger than input is
  // malformed, and subtracting more than exists would produce a negative bill.
  const cached = Math.min(sane(usage.cachedInputTokens), input)
  const reasoning = Math.min(sane(usage.reasoningTokens), output)

  const freshInput = input - cached
  const billableOutput = output - reasoning

  if (price === undefined) {
    return {
      provider,
      model,
      inputUsd: 0,
      outputUsd: 0,
      cachedInputUsd: 0,
      reasoningUsd: 0,
      totalUsd: 0,
      unknownModel: true,
      cacheHitRate: input > 0 ? cached / input : 0,
    }
  }

  // A cached read falls back to the fresh-input rate when the row has no cache
  // price: under-reporting would be wrong, and this row simply does not know.
  const cachedRate = price.cachedInputPerMillion ?? price.inputPerMillion
  const reasoningRate = price.reasoningPerMillion ?? price.outputPerMillion

  const inputUsd = usd(freshInput, price.inputPerMillion)
  const cachedInputUsd = usd(cached, cachedRate)
  const outputUsd = usd(billableOutput, price.outputPerMillion)
  const reasoningUsd = usd(reasoning, reasoningRate)

  return {
    provider,
    model,
    inputUsd,
    outputUsd,
    cachedInputUsd,
    reasoningUsd,
    totalUsd: inputUsd + cachedInputUsd + outputUsd + reasoningUsd,
    unknownModel: false,
    cacheHitRate: input > 0 ? cached / input : 0,
  }
}

/** One row of a running session total. */
export interface SessionCost {
  provider: string
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  usd: number
  /** True when any call used a model with no price row. */
  hasUnknownModel: boolean
}

export function emptySessionCost(): SessionCost {
  return {
    provider: "",
    model: "",
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    usd: 0,
    hasUnknownModel: false,
  }
}

/**
 * Accumulate a running total.
 *
 * Mutates and returns `acc` so a hot path can call it without allocating; the
 * caller owns the object. The `provider`/`model` on the accumulator record the
 * FIRST model seen, because a session that switches model is a fact worth
 * showing rather than averaging away.
 */
export function accumulateCost(
  acc: SessionCost,
  provider: string,
  model: string,
  usage: TokenUsage,
): SessionCost {
  if (acc.provider === "") {
    acc.provider = provider
    acc.model = model
  }
  acc.calls += 1
  acc.inputTokens += sane(usage.inputTokens)
  acc.outputTokens += sane(usage.outputTokens)
  acc.cachedInputTokens += Math.min(sane(usage.cachedInputTokens), sane(usage.inputTokens))

  const estimate = estimateCost(provider, model, usage)
  if (estimate.unknownModel) {
    acc.hasUnknownModel = true
  } else {
    acc.usd += estimate.totalUsd
  }
  return acc
}

/** Sum several accumulators. */
export function totalCost(parts: readonly SessionCost[]): SessionCost {
  const out = emptySessionCost()
  for (const part of parts) {
    if (out.provider === "" && part.provider !== "") {
      out.provider = part.provider
      out.model = part.model
    }
    out.calls += part.calls
    out.inputTokens += part.inputTokens
    out.outputTokens += part.outputTokens
    out.cachedInputTokens += part.cachedInputTokens
    out.usd += part.usd
    out.hasUnknownModel = out.hasUnknownModel || part.hasUnknownModel
  }
  return out
}

/** Format USD for a terminal. Sub-cent amounts keep more precision. */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return "$0.00"
  if (amount === 0) return "$0.00"
  if (amount < 0.01) return `$${amount.toFixed(4)}`
  if (amount < 1) return `$${amount.toFixed(3)}`
  return `$${amount.toFixed(2)}`
}

/** One-line cost row for `/stats`. */
export function formatCostLine(cost: SessionCost): string {
  const name = cost.provider === "" ? "unknown" : `${cost.provider}/${cost.model}`
  const price = cost.hasUnknownModel ? " (partial — unpriced model)" : ""
  return `${name}: ${cost.calls} call(s), ${cost.inputTokens}→${cost.outputTokens} tokens, ${formatUsd(cost.usd)}${price}`
}

/**
 * Project the cost of a token budget at a given model.
 *
 * Lets `/budget` answer "what does 500k tokens actually cost me" instead of only
 * "how many tokens have I used".
 */
export function projectBudgetCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): { usd: number; known: boolean } {
  const estimate = estimateCost(provider, model, { inputTokens, outputTokens })
  return { usd: estimate.totalUsd, known: !estimate.unknownModel }
}

/** Context window for a model, when the table knows it. */
export function contextWindowFor(provider: string, model: string): number | undefined {
  return findPrice(provider, model)?.contextWindow
}