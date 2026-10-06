/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { StopReason } from "./messages.js"

/**
 * One place that decides what a provider's wire-level stop/finish reason means.
 *
 * ## Why this exists
 *
 * `agent-loop.ts` continues an answer that the model cut off by exhausting its
 * output budget: it checks `assistant.stopReason === "length"` and, if so, feeds
 * a "continue where you stopped" nudge back to the model. That continuation is
 * the ONLY thing standing between a long answer and a severed one.
 *
 * Both provider adapters used to classify finish reasons with an exact-match
 * `switch` whose `default` arm returned `"end_turn"`:
 *
 *   - `nvidia.ts`  `mapFinishReason`  — OpenAI and every OpenAI-compatible gateway
 *   - `anthropic.ts` `mapAnthropicStop`
 *
 * `"length"` is OpenAI's spelling. It is not the only one. Measured against the
 * field's real-world variants, an unrecognised reason silently became
 * `"end_turn"`, the loop saw a *finished* answer, never nudged, and returned the
 * response cut off mid-sentence — with no error and no marker. Any
 * OpenAI-compatible gateway using a different spelling hit this, and the
 * gateway list is long (Ollama, vLLM, LM Studio, llama.cpp, OpenRouter,
 * Together, Groq, Cerebras, DeepInfra, …).
 *
 * Failing *open* into `end_turn` is the worst possible default here: it
 * converts a recoverable "the model ran out of room, ask it to continue" into an
 * unrecoverable "here is a truncated answer that looks complete". Unmapped
 * reasons must therefore resolve to the safest interpretation, not the
 * most convenient one.
 *
 * ## Rule
 *
 * Normalise the spelling (case, `-`/` ` vs `_`, and the provider prefixes), then
 * match on meaning. `length` is treated as the DEFAULT for anything that signals
 * a token/output ceiling, because that is the condition the loop knows how to
 * recover from; a false `length` costs one redundant continuation turn, while a
 * false `end_turn` costs the user their answer.
 */

/** Wire spellings that mean "the model hit its output ceiling". */
const LENGTH_REASONS: ReadonlySet<string> = new Set([
  "length",
  "max_tokens",
  "max_output_tokens",
  "max_new_tokens",
  "max_completion_tokens",
  "model_length",
  "model_length_reached",
  "token_limit",
  "output_limit",
  "response_length_exceeded",
  "incomplete", // Gemini: finishReason INCOMPLETE, its length condition
])

/** Wire spellings that mean "the model wants a tool called". */
const TOOL_REASONS: ReadonlySet<string> = new Set(["tool_calls", "tool_use", "function_call", "tool_call"])

/** Wire spellings that mean "the caller aborted". */
const ABORT_REASONS: ReadonlySet<string> = new Set(["abort", "aborted", "cancel", "cancelled", "canceled"])

/** Wire spellings that mean "the model failed, not the caller". */
const ERROR_REASONS: ReadonlySet<string> = new Set(["error", "failed", "failure"])

/**
 * Canonicalise a provider stop/finish reason: lowercase, drop the provider's
 * namespace prefix (`openai.`, `anthropic.`, …), and unify separators so that
 * `MAX_TOKENS`, `max-tokens`, `Max Tokens` and `maxTokens` all collapse to the
 * same key.
 */
function canonicalizeStopReason(reason: string): string {
  let key = reason.trim().toLowerCase()
  // Strip a dotted namespace prefix only — never a leading digit or dash.
  const dot = key.lastIndexOf(".")
  if (dot > 0 && dot < key.length - 1) key = key.slice(dot + 1)
  return key.replace(/[\s-]+/g, "_")
}

/**
 * Map a provider wire reason onto the protocol's `StopReason`.
 *
 * Unknown reasons resolve to `"length"` rather than `"end_turn"`: see the module
 * comment. `agent-loop.ts` treats that as "the answer may be incomplete" and
 * nudges for a continuation, which is recoverable, whereas `"end_turn"` reports
 * a truncated answer as a finished one.
 */
export function stopReasonFromWire(reason: string | null | undefined): StopReason {
  if (reason === null || reason === undefined) return "length"
  const key = canonicalizeStopReason(String(reason))
  if (key.length === 0) return "length"
  if (LENGTH_REASONS.has(key)) return "length"
  if (TOOL_REASONS.has(key)) return "tool_use"
  if (ABORT_REASONS.has(key)) return "aborted"
  if (ERROR_REASONS.has(key)) return "error"
  // Explicitly-complete terminations are the only safe unknown.
  if (key === "stop" || key === "end_turn" || key === "eos" || key === "stop_sequence" || key === "end_turn_filtered") {
    return "end_turn"
  }
  // Content filtering genuinely did finish the turn without running out of
  // tokens, so a continuation would not help and looping would be wasteful.
  if (key === "content_filter" || key === "safety" || key === "recitation") return "end_turn"
  return "length"
}

/**
 * True when a stop reason means the answer was cut off by the output ceiling and
 * is therefore a candidate for a continuation turn.
 *
 * Kept as a named predicate so `agent-loop.ts` reads as intent rather than as a
 * string comparison, and so the recovery rule lives next to the vocabulary.
 */
export function isLengthStop(stopReason: StopReason | null | undefined): boolean {
  return stopReason === "length"
}
