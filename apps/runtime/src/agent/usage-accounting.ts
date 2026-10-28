/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { getRolloutBudget } from "../../../../packages/core/src/rollout_budget.js"
import { estimateTokens } from "../../../../packages/core/src/token_budget.js"

/**
 * Charge one model call to the rollout budget.
 *
 * The provider protocol carries no usage/token fields (`Provider.chat` returns
 * a bare `AssistantMessage`), so both sides are ESTIMATES using the repo-wide
 * `ceil(chars / 4)` convention: `inputText` is what was actually sent,
 * `outputText` is what came back. `nemo_rollout_budget_units` is the
 * sanctioned caller-side override (samplingTokenWeight = 1 ⇒ 1 estimated token
 * = 1 unit on BOTH sides); the protected `packages/core` accounting is not
 * touched.
 *
 * BOTH sides are charged (#64): the core accounting weights `output_tokens`
 * only, which made a token cap blind to the denial-loop burn — each retry turn
 * re-pays the whole (growing) context as input while emitting a tiny output.
 *
 * Every model call must route through here. A call made outside the turn loop
 * is invisible to the budget, so the loop can spend past a cap the user set.
 * Recording is best-effort: budget bookkeeping must never break a turn, which
 * is why this swallows its own errors.
 */
export function recordModelUsage(inputText: string, outputText: string): void {
  try {
    const inputTokens = estimateTokens(inputText)
    const outputTokens = estimateTokens(outputText)
    getRolloutBudget().recordUsage({
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      nemo_rollout_budget_units: inputTokens + outputTokens,
    })
  } catch {
    /* budget accounting is best-effort — never break a turn over it */
  }
}
