/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Provider error middleware — one classification for every provider failure.
 *
 * Why this exists
 * ---------------
 * `retry.ts` already answers the retry question (`classifyRetry`), and it
 * answers it well. What it does NOT answer is the rest of what a failure
 * needs to become a useful message: is this an auth problem the user can fix,
 * a context overflow the loop can recover from, or a gateway hiccup worth
 * riding out? Those were being answered by three INLINE REGEXES inside
 * `agent-loop.ts`, which is the duplication `retry.ts` was created to end —
 * ledger bug #25 was a mistake that existed in four files because the code
 * had been copy-pasted instead of shared.
 *
 * The live consequence, and the reason this module is worth writing
 * ----------------------------------------------------------------
 * The loop's outer restart check still carried the exact false-positive that
 * `chatWithRetry`'s own docstring says was removed:
 *
 *     /429|too many requests|…|\b5\d{2}\b/i
 *
 * `\b5\d{2}\b` matches the three digits "500" ANYWHERE — including a model
 * name, a token count, or a quoted user prompt. So a session configured for
 * `qwen-500` would retry "model qwen-500 failed: bad key" five times before
 * surfacing a fatal error the user needed to see immediately. The inner call
 * was fixed; the outer copy was not, because it was a second copy.
 *
 * How this avoids repeating that mistake
 * --------------------------------------
 * **The status is EXTRACTED, never pattern-matched as a bare number.** A
 * status is only believed when it is introduced by something that says it is
 * one — `HTTP 500:`, `status 500`, a leading `500 Internal Server Error`, or
 * a structured field on the error. `qwen-500` has none of those, so it is not
 * a status, and the failure falls through to the message and body text where
 * "bad key" is correctly an auth problem.
 *
 * Everything else here follows the same shape: status is the authority, the
 * body is the next witness, and the prose is the last resort — the same
 * precedence `classifyRetry` documents, so the two modules cannot disagree.
 */

import { classifyRetry, parseRetryAfter, type RetryableClass } from "./retry.js"

/** What kind of failure this is, independent of whether it is worth retrying. */
export type ProviderErrorKind =
  /** The caller aborted. Never a provider problem. */
  | "aborted"
  /** Credentials rejected (401/403, bad key, invalid authentication). */
  | "auth"
  /** Rate limited (429), with or without a Retry-After. */
  | "rate-limit"
  /** Quota or billing exhausted (402, insufficient_quota). */
  | "quota"
  /** The request itself is too large for the window. */
  | "context-overflow"
  /** Malformed or unsupported request (400 family). */
  | "invalid-request"
  /** The named model does not exist on this endpoint. */
  | "model-not-found"
  /** The provider's safety layer blocked the request or the response. */
  | "content-filter"
  /** Upstream server fault (5xx). */
  | "server"
  /** The socket, not the request: reset, refused, DNS, unreachable. */
  | "network"
  /** The request took too long (408, ETIMEDOUT, "timed out"). */
  | "timeout"
  /** A 200 with no usable content. */
  | "empty-response"
  /** Nothing matched. Treated as fatal — surfaced, never silently retried. */
  | "unknown"

export interface ProviderErrorInput {
  /** The thrown value, when there is one. */
  error?: unknown
  /** An explicitly known HTTP status, when the caller has one. */
  status?: number
  /** Raw response body text, when the caller kept it. Providers put the real
   *  reason in the body far more often than in the status line. */
  body?: string
  /** Server-sent Retry-After, in whatever type the client surfaced it as. */
  retryAfter?: unknown
  /** True when the caller has aborted. Wins over every other signal. */
  aborted?: boolean
}

export interface ProviderErrorInfo {
  kind: ProviderErrorKind
  /** The retry decision, from the shared classifier so the two cannot drift. */
  retryClass: RetryableClass
  retryable: boolean
  httpStatus?: number
  /** Retry-After in ms, or undefined when the server did not send one. */
  retryAfterMs?: number
  /** Actionable one-liner for the user, when there is something to say. */
  hint?: string
  /** Best-effort normalized message, with nested AggregateError causes joined. */
  message: string
  /** The error's own code (ECONNRESET …), when it carries one. */
  code?: string
}

/* ------------------------------------------------------------------ *
 * Message extraction
 * ------------------------------------------------------------------ */

/** Pull a string `code` off an unknown thrown value. */
function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" && code.length > 0 ? code : undefined
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error === null || error === undefined) return ""
  return String(error)
}

/**
 * Flatten a thrown value into one message and its code.
 *
 * Node's happy-eyeballs connect failure surfaces as an `AggregateError`
 * whose `.message` is EMPTY — the real "connect ECONNREFUSED …" texts live in
 * its nested `errors`. A `message.trim()` guard then dropped the failure
 * entirely, so the turn ended with no row and no log line ("type a message,
 * press Enter, nothing happens"). The nested causes are joined so the failure
 * is always loud AND useful.
 *
 * A plain `Error.cause` chain is walked too: several providers wrap their
 * real error behind "fetch failed" and keep the detail one level down.
 */
export function flattenError(error: unknown): { message: string; code?: string } {
  const code = errorCode(error)
  const parts: string[] = []

  const visit = (value: unknown, depth: number): void => {
    if (value === null || value === undefined || depth > 4) return
    const own = errorMessage(value).trim()
    if (own.length > 0 && !parts.includes(own)) parts.push(own)

    if (value instanceof AggregateError && Array.isArray(value.errors)) {
      for (const nested of value.errors) visit(nested, depth + 1)
      return
    }
    if (typeof value === "object" && "cause" in value) {
      visit((value as { cause?: unknown }).cause, depth + 1)
    }
  }
  visit(error, 0)

  const message = parts.length > 0 ? parts.join("; ") : errorMessage(error)
  return code === undefined ? { message } : { message, code }
}

/**
 * Structured HTTP status fields providers use.
 *
 * `error.status` is what `withRetry` reads, but undici exposes
 * `error.response.status`, several gateways use `statusCode`, and some use
 * `httpStatus`. Looking only at `status` meant a 429 arriving on any of those
 * other fields was classified from its prose instead of its status — and the
 * prose is the thing most likely to lie.
 */
function statusFromFields(error: unknown): number | undefined {
  const candidates: unknown[] = []
  const push = (value: unknown): void => {
    if (value === null || typeof value !== "object") return
    const rec = value as Record<string, unknown>
    candidates.push(rec.status, rec.statusCode, rec.httpStatus)
    if (rec.response !== null && typeof rec.response === "object") {
      candidates.push((rec.response as Record<string, unknown>).status)
    }
  }
  push(error)
  // `typeof null === "object"` is true in JS, so the null check has to come
  // first. Reading `.cause` off a null threw a TypeError that no test caught
  // because every other input was a real Error.
  if (error !== null && typeof error === "object") push((error as { cause?: unknown }).cause)

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599) {
      return candidate
    }
  }
  return undefined
}

/**
 * Extract an HTTP status from TEXT — only where the text itself says it is one.
 *
 * This is the whole point of the module. Each pattern requires an introducer
 * that means "the following three digits are a status": `HTTP`, `status`, the
 * standard reason phrase, or the status at the very start of the line. A
 * model name like `qwen-500` matches none of them, so it is not a status and
 * cannot be misread as a transient 5xx — which is the failure the old
 * `\b5\d{2}\b` had.
 */
export function extractHttpStatus(text: string): number | undefined {
  if (text.length === 0) return undefined

  const patterns: RegExp[] = [
    /\bHTTP[/\s]+(\d{3})\b/i,
    /\bstatus(?:[\s:_-]+code)?[\s:]+(\d{3})\b/i,
    /\b(\d{3})\s+(?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|Bad Request|Unauthorized|Forbidden|Not Found|Too Many Requests|Request Entity Too Large|Payload Too Large|Unprocessable|Not Implemented|Request Timeout)\b/i,
    /^\s*(\d{3})\s+[A-Za-z]/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match === null) continue
    const status = Number(match[1])
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status
  }
  return undefined
}

/** A status out of a JSON body (`{"error":{"code":429}}`), when present. */
function statusFromBody(body: string): number | undefined {
  if (body.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object") return undefined
  const error = (parsed as { error?: unknown }).error
  if (error === null || typeof error !== "object") return undefined
  const rec = error as Record<string, unknown>
  for (const candidate of [rec.code, rec.status, rec.httpStatus]) {
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599) {
      return candidate
    }
    if (typeof candidate === "string") {
      const numeric = Number(candidate)
      if (Number.isInteger(numeric) && numeric >= 100 && numeric <= 599) return numeric
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

/** Keywords that mean "the window is full", by any name a provider uses. */
const CONTEXT_OVERFLOW =
  /exceeds the available context|exceed_context_size|exceeds?\s+the\s+maximum|maximum context length|context length|context window|too many tokens|prompt is too long|request is too large|request too large|input is too long|string too long/i

/** Rate limiting, when no status is available to say so. */
const RATE_LIMITED = /\b429\b|too many requests|rate.?limit|quota exceeded|requests? per (?:minute|day|hour)|too many requests/i

/** Credentials, when no status is available to say so. */
const AUTH = /invalid (?:username or password|api key|authentication|credentials)|incorrect api key|bad api key|no api key|missing api key|authentication (?:failed|error)|unauthorized|forbidden|permission denied|access denied|invalid token|expired token/i

/** Billing, when no status is available to say so. */
const QUOTA = /insufficient[_ ]quota|insufficient (?:credits|balance|funds)|billing|payment required|quota (?:exceeded|reached)|quota is exhausted/i

/** Safety systems, on either side of the wire. */
const CONTENT_FILTER = /content (?:filter|policy|moderation)|flagged by|blocked by (?:moderation|safety)|safety (?:system|filter)|harmful content|responsib/i

/** Model naming, when no status is available to say so. */
const MODEL_NOT_FOUND =
  /model (?:not found|does not exist|is not available|unavailable)|model\b[^,\n]{0,40}\bdoes not exist|unknown model|no such model|invalid model/i

/** The socket, not the request. Matches errno codes and their prose forms. */
const NETWORK =
  /ECONNRESET|ECONNABORTED|ECONNREFUSED|EPIPE|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EAI_AGAIN|ENOTFOUND|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET|HEADERS_TIMEOUT)|socket hang ?up|connection (?:closed|refused|reset)|fetch failed|network (?:error|unreachable|down)|broken pipe|other side closed/i

/** The request took too long. */
const TIMEOUT = /ETIMEDOUT|timed?\s?out|timeout|deadline exceeded/i

/** A 200 that carried nothing usable. */
const EMPTY_RESPONSE = /empty response|no content|empty completion|no choices/i

/**
 * Classify a provider failure into a kind plus the shared retry decision.
 *
 * Pure and total: every input produces a `ProviderErrorInfo`, and nothing
 * here throws. The precedence is deliberate and matches `classifyRetry` so
 * the two cannot disagree — abort, then status, then the error's own code,
 * then body keywords, then message keywords, and only then unknown.
 */
export function classifyProviderError(input: ProviderErrorInput): ProviderErrorInfo {
  const flattened = flattenError(input.error)
  const explicitStatus =
    typeof input.status === "number" && Number.isInteger(input.status) && input.status >= 100 && input.status <= 599
      ? input.status
      : undefined
  const fieldStatus = statusFromFields(input.error)
  const bodyStatus = statusFromBody(input.body ?? "")
  const status =
    explicitStatus ?? fieldStatus ?? extractHttpStatus(flattened.message) ?? bodyStatus ?? extractHttpStatus(input.body ?? "")

  const retryAfterSeconds = parseRetryAfter(input.retryAfter) ?? parseRetryAfter(errorRetryAfter(input.error))
  const retryAfterMs = retryAfterSeconds === undefined ? undefined : Math.round(retryAfterSeconds * 1000)

  const message = flattened.message.length > 0 ? flattened.message : "unknown provider error"
  const haystack = `${message} ${input.body ?? ""}`

  const base = {
    ...(status === undefined ? {} : { httpStatus: status }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    message,
    ...(flattened.code === undefined ? {} : { code: flattened.code }),
  }

  const finish = (kind: ProviderErrorKind, retryClass?: RetryableClass): ProviderErrorInfo => {
    const cls =
      retryClass ??
      classifyRetry({
        error: input.error,
        ...(status === undefined ? {} : { status }),
        aborted: input.aborted === true,
      })
    return { ...base, kind, retryClass: cls, retryable: cls === "transient" || cls === "rate-limited" }
  }

  // 1. Abort wins over everything. Retrying after the user pressed Ctrl+C is
  //    the single most annoying failure an agent can have.
  if (input.aborted === true) return finish("aborted", "aborted")

  // 2. A provider that answered with nothing usable is its own case: the
  //    request succeeded and the content did not arrive.
  if (EMPTY_RESPONSE.test(haystack) || isEmptyResponseError(input.error)) return finish("empty-response", "transient")

  // 3. The error's own code, before any prose: a code is structured.
  //    ETIMEDOUT is a connection code but not in the NETWORK list, so the
  //    guard has to accept either — testing only NETWORK silently dropped it
  //    and a timeout-by-code classified as "unknown".
  const code = flattened.code
  if (code !== undefined && (TIMEOUT.test(code) || NETWORK.test(code))) {
    return finish(TIMEOUT.test(code) ? "timeout" : "network", "transient")
  }

  // 4. Status is the authority.
  if (status !== undefined) {
    if (status === 401 || status === 403) return finish("auth", "fatal")
    if (status === 429) return finish("rate-limit", "rate-limited")
    if (status === 402) return finish("quota", "fatal")
    if (status === 404) return finish(MODEL_NOT_FOUND.test(haystack) ? "model-not-found" : "invalid-request", "fatal")
    if (status === 408) return finish("timeout", "transient")
    if (status === 400 || status === 413 || status === 422) {
      if (CONTEXT_OVERFLOW.test(haystack)) return finish("context-overflow", "fatal")
      if (CONTENT_FILTER.test(haystack)) return finish("content-filter", "fatal")
      if (MODEL_NOT_FOUND.test(haystack)) return finish("model-not-found", "fatal")
      if (QUOTA.test(haystack)) return finish("quota", "fatal")
      return finish("invalid-request", "fatal")
    }
    if (status >= 500) return finish("server", "transient")
    if (status >= 400) return finish("invalid-request", "fatal")
    if (status >= 200 && status < 300) {
      // A 2xx with an error-shaped meaning falls through to the keywords
      // below: Anthropic emits context-overflow and safety errors with a 200
      // and the real reason only in the body.
    }
  }

  // 5. Body and message keywords, in the order that matters most to the user.
  if (CONTEXT_OVERFLOW.test(haystack)) return finish("context-overflow", "fatal")
  if (RATE_LIMITED.test(haystack)) return finish("rate-limit", "rate-limited")
  if (AUTH.test(haystack)) return finish("auth", "fatal")
  if (QUOTA.test(haystack)) return finish("quota", "fatal")
  if (CONTENT_FILTER.test(haystack)) return finish("content-filter", "fatal")
  if (MODEL_NOT_FOUND.test(haystack)) return finish("model-not-found", "fatal")
  if (TIMEOUT.test(haystack)) return finish("timeout", "transient")
  if (NETWORK.test(haystack)) return finish("network", "transient")

  // 6. Nothing matched. Unknown is fatal on purpose: a failure nobody
  //    recognized is exactly the one a user needs to see, and retrying it
  //    blindly is how a permanent error becomes a 30-second stall.
  return finish("unknown", "fatal")
}

/** Read a Retry-After off the error itself, in whatever field it landed on. */
function errorRetryAfter(error: unknown): unknown {
  if (error === null || typeof error !== "object") return undefined
  const rec = error as Record<string, unknown>
  for (const key of ["retryAfter", "retry-after", "retryAfterMs"]) {
    if (rec[key] !== undefined) return rec[key]
  }
  const response = rec.response
  if (response !== null && typeof response === "object") {
    const headers = (response as { headers?: unknown }).headers
    if (headers !== null && typeof headers === "object") {
      const rec2 = headers as Record<string, unknown>
      for (const key of ["retry-after", "retryAfter"]) {
        if (rec2[key] !== undefined) return rec2[key]
      }
    }
  }
  return undefined
}

function isEmptyResponseError(error: unknown): boolean {
  return error instanceof Error && error.name === "ProviderEmptyResponseError"
}

/**
 * The actionable line for a classified failure.
 *
 * One place, so every surface that renders a provider error says the same
 * thing — the transcript row, the audit log, and the TUI banner. A hint that
 * differs between surfaces is a hint nobody trusts.
 */
export function providerErrorHint(info: ProviderErrorInfo): string | undefined {
  switch (info.kind) {
    case "auth":
      return "\nKey rejected — run `/provider key` to re-check and fix the API key (it pings the real chat endpoint)."
    case "rate-limit":
      return info.retryAfterMs !== undefined
        ? `\nRate limited — the server asked for ${Math.round(info.retryAfterMs / 1000)}s; backing off accordingly.`
        : "\nRate limited — backing off and retrying."
    case "quota":
      return "\nQuota or billing exhausted — check the provider dashboard, then run `/provider key` to switch accounts."
    case "context-overflow":
      return "\nThe request is larger than the model's window — compacting the session and retrying."
    case "network":
      return "\nThe connection dropped (socket/DNS), not the request — retrying."
    case "timeout":
      return "\nThe provider did not answer in time — retrying."
    case "server":
      return "\nUpstream server error — retrying."
    case "content-filter":
      return "\nThe provider's safety filter blocked this request — rephrase, or switch models."
    case "model-not-found":
      return "\nThat model is not served by this endpoint — run `/models` to pick an available one."
    case "empty-response":
      return "\nThe provider returned an empty completion — retrying."
    case "invalid-request":
      return "\nThe provider rejected the request itself — retrying cannot fix it."
    case "aborted":
      return undefined
    case "unknown":
      return undefined
    default:
      // Exhaustive with a fail-safe default: a new kind renders no hint rather
      // than claiming something about the error that may not be true.
      return undefined
  }
}

/** True when the loop should try to recover by compacting. */
export function isContextOverflowError(info: ProviderErrorInfo): boolean {
  return info.kind === "context-overflow"
}

/** True when the user can act on it themselves. */
export function isAuthError(info: ProviderErrorInfo): boolean {
  return info.kind === "auth"
}
