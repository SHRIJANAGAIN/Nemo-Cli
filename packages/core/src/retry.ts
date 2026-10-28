/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Retry with backoff, jitter, and an explicit retryability decision.
 *
 * This logic existed, but it was duplicated: `chatWithRetry` inside
 * agent-loop.ts had one copy, and every provider (llama-cpp, nvidia, google,
 * anthropic) had another. Ledger bug #25 is what that duplication costs — the
 * stale-watchdog mistake existed in FOUR files at once because the code had
 * been copy-pasted rather than shared.
 *
 * Three properties this module exists to guarantee, each of which has already
 * cost a real defect:
 *
 *  1. **Fatal is fatal.** A retried 400/401/404 fails identically every time, so
 *     retrying it just delays the error the user needed to see. The classifier is
 *     a single exported function with the whole decision in one place.
 *
 *  2. **Jitter is not optional.** Exponential backoff without jitter makes every
 *     concurrent client retry in lockstep, so the outage that one client caused
 *     is amplified N-fold by the herd that followed it.
 *
 *  3. **The clock is injectable.** A retry module whose tests sleep for real is a
 *     retry module whose tests get skipped on CI for being slow, which is
 *     exactly when retry logic breaks.
 */

export type RetryableClass =
  /** Transient: worth another attempt (network blip, 5xx, rate limit). */
  | "transient"
  /** Rate-limited specifically: honours Retry-After when the server sent one. */
  | "rate-limited"
  /** Permanent: another attempt fails identically (400/401/404/422). */
  | "fatal"
  /** The caller aborted; never retry, and propagate the abort. */
  | "aborted"

/** HTTP statuses that are always a rate limit, whatever the body says. */
const RATE_LIMIT_STATUSES = new Set([429, 503])

/** HTTP statuses that are always transient. */
const TRANSIENT_STATUSES = new Set([408, 425, 500, 502, 503, 504, 507, 509, 522, 524])

/** HTTP statuses that can never succeed on a retry. */
const FATAL_STATUSES = new Set([400, 401, 402, 403, 404, 405, 409, 413, 414, 415, 422, 451])

/** Network-level error codes that mean "the socket, not the request". */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
])

export interface ClassifyInput {
  error?: unknown
  status?: number
  /** Server-sent Retry-After, in seconds. */
  retryAfterSeconds?: number
  /** True when the caller has aborted. */
  aborted?: boolean
}

/**
 * Coerce a Retry-After value to seconds.
 *
 * Providers disagree on the type: several HTTP clients expose the header as the
 * STRING `"1"` while others surface a number. The previous inline retry used
 * `parseInt(retryAfter, 10)` and so handled the string; a `typeof === "number"`
 * check silently does not, and the server's instruction to wait is then ignored
 * in favour of our own backoff — which is how a client ends up hammering an
 * endpoint that explicitly asked it to stop.
 */
export function parseRetryAfter(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed.length === 0) return undefined
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
  }
  return undefined
}

/** Pull a numeric `code` off an unknown thrown value, if it has one. */
function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error === null || error === undefined) return ""
  return String(error)
}

/**
 * Classify a failure.
 *
 * Order matters and is deliberate:
 *  1. **Abort wins over everything.** Retrying after the user pressed Ctrl+C is
 *     the single most annoying failure an agent can have, so it is checked first
 *     and can never be overridden by a "transient" signal.
 *  2. **Status before message.** A 401 that says "rate limit, try later" is
 *     still fatal; the status is the authority, the prose is not.
 *  3. **Message only as a last resort**, for errors that never reach the wire
 *     (a DNS failure, a socket reset) and therefore carry no status.
 */
export function classifyRetry(input: ClassifyInput): RetryableClass {
  if (input.aborted === true) return "aborted"

  const status = input.status
  if (typeof status === "number") {
    if (RATE_LIMIT_STATUSES.has(status)) return "rate-limited"
    if (TRANSIENT_STATUSES.has(status)) return "transient"
    if (FATAL_STATUSES.has(status)) return "fatal"
    // An unrecognised 4xx is treated as fatal: a 4xx means the request itself
    // was rejected, and repeating it verbatim cannot succeed.
    if (status >= 400 && status < 500) return "fatal"
    if (status >= 500) return "transient"
  }

  const code = errorCode(input.error)
  if (code !== undefined && TRANSIENT_CODES.has(code)) return "transient"

  const message = errorMessage(input.error)
  if (message.length === 0) return "fatal"

  // Explicit rate-limit phrasing, checked before the generic transient list so a
  // "429 rate limit" message still classifies as rate-limited even without a status.
  if (/\b429\b|too many requests|rate.?limit/i.test(message)) return "rate-limited"

  if (/socket hang up|connection (?:closed|refused|reset)|network|fetch failed|timed? ?out|temporarily unavailable|service unavailable|overloaded/i.test(message)) {
    return "transient"
  }

  return "fatal"
}

/** True when another attempt is worth making. */
export function isRetryable(input: ClassifyInput): boolean {
  const cls = classifyRetry(input)
  return cls === "transient" || cls === "rate-limited"
}

export interface RetryOptions {
  /** Total attempts INCLUDING the first. 1 means no retry at all. */
  maxAttempts: number
  /** Delay before the first retry, in ms. Doubles each attempt. */
  baseDelayMs?: number
  /** Ceiling for a single delay. */
  maxDelayMs?: number
  /** Upper bound on total elapsed time across all attempts. */
  totalTimeoutMs?: number
  /**
   * Fraction of the delay to randomise, 0..1. 0.25 means "add up to 25% of the
   * computed delay", which is full-ish jitter while still respecting the backoff
   * shape.
   */
  jitterRatio?: number
  /** Injectable random source; tests pass a constant for determinism. */
  random?: () => number
  /** Injectable clock, for `totalTimeoutMs`. Tests advance it themselves. */
  now?: () => number
  /** Injectable sleep. Tests resolve immediately and assert the delays instead. */
  sleep?: (ms: number) => Promise<void>
  /** Re-read each attempt so a Retry-After from attempt N informs attempt N+1. */
  retryAfterSeconds?: number
  /** Called before each sleep; the hook point for emitting a retry notice. */
  onRetry?: (info: { attempt: number; delayMs: number; reason: RetryableClass; error?: unknown }) => void
}

export interface RetryOutcome<T> {
  ok: boolean
  value?: T
  error?: unknown
  /** Attempts actually made. */
  attempts: number
  /** Total time spent, per the injected clock. */
  elapsedMs: number
  /** Every delay the policy chose, in order — asserted directly by tests. */
  delaysMs: number[]
  /** True when the run stopped because the total budget ran out. */
  timedOut: boolean
  lastClass: RetryableClass
}

const DEFAULT_BASE_MS = 750
const DEFAULT_MAX_MS = 30_000

/**
 * The error surfaced when the caller aborts mid-retry.
 *
 * A named export because the agent loop's transcript test asserts this exact
 * string: it distinguishes "you cancelled this" from "the provider failed", and
 * those are different things for a user to read.
 */
export const ABORT_MESSAGE = "Operation aborted during provider retry."

/**
 * Compute the delay before attempt `attempt` (1-based: the delay before attempt
 * 2 is `backoffDelay(2, …)`).
 *
 * Full-jitter would be `random() * cap`, but that discards the backoff shape and
 * can retry instantly. Adding a random fraction of the cap keeps the growth while
 * breaking up the herd.
 */
export function backoffDelay(
  attempt: number,
  baseDelayMs = DEFAULT_BASE_MS,
  maxDelayMs = DEFAULT_MAX_MS,
  jitterRatio = 0.25,
  random: () => number = Math.random,
): number {
  const step = Math.max(1, Math.floor(attempt))
  // exponent is capped so 2**n cannot reach Infinity before the min() clamps it.
  const raw = baseDelayMs * 2 ** Math.min(step - 1, 20)
  const capped = Math.min(raw, maxDelayMs)
  if (jitterRatio <= 0) return Math.round(capped)
  const jitter = capped * jitterRatio * random()
  return Math.round(Math.min(capped + jitter, maxDelayMs))
}

/** Abortable sleep that resolves early on abort instead of burning the delay. */
function defaultSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Run `operation` under a retry policy.
 *
 * NEVER THROWS for the operation's own failure — the outcome carries it. That is
 * deliberate: the agent loop's error path has to render a provider failure as a
 * message row, and a thrown error there would bypass the audit trail and the
 * transcript. The one thing that DOES throw is a programming error in the
 * arguments, which cannot be a transient network blip.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
  signal?: AbortSignal,
): Promise<RetryOutcome<T>> {
  const maxAttempts = Number.isFinite(options.maxAttempts) ? Math.max(1, Math.floor(options.maxAttempts)) : 1
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_MS
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_MS
  const jitterRatio = options.jitterRatio ?? 0.25
  const random = options.random ?? Math.random
  const now = options.now ?? ((): number => Date.now())
  const sleep = options.sleep ?? ((ms: number): Promise<void> => defaultSleep(ms, signal))
  const totalTimeoutMs = options.totalTimeoutMs

  const startedAt = now()
  const delaysMs: number[] = []
  let lastClass: RetryableClass = "fatal"
  let lastError: unknown
  let abortError: Error | undefined
  // A function rather than an inline `signal?.aborted === true`: the loop's own
  // guard already narrowed that expression to `false | undefined`, so reusing it
  // inside the catch produced a comparison TypeScript flagged as impossible.
  const abortedNow = (): boolean => signal !== undefined && signal.aborted

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (abortedNow()) {
      // An abort observed BETWEEN attempts (the sleep resolved early) must also
      // surface as the abort, not as whatever network error happened to come
      // first. Otherwise the user is told a connection dropped when they were the
      // one who cancelled it.
      lastClass = "aborted"
      return {
        ok: false,
        error: new Error(ABORT_MESSAGE),
        attempts: attempt - 1,
        elapsedMs: Math.max(0, now() - startedAt),
        delaysMs,
        timedOut: false,
        lastClass,
      }
    }

    try {
      const value = await operation(attempt)
      return {
        ok: true,
        value,
        attempts: attempt,
        elapsedMs: Math.max(0, now() - startedAt),
        delaysMs,
        timedOut: false,
        lastClass: "fatal",
      }
    } catch (error) {
      lastError = error
      const status = (error as { status?: unknown }).status
      const retryAfterSeconds = parseRetryAfter((error as { retryAfter?: unknown }).retryAfter)
      lastClass = classifyRetry({
        error,
        ...(typeof status === "number" ? { status } : {}),
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        // Read into a local first: the top-of-loop guard already narrowed
        // `signal?.aborted` to `false | undefined`, so the inline comparison
        // read as provably impossible to the compiler.
        aborted: abortedNow(),
      })

      if (lastClass === "aborted") {
        // Preserve the abort as its own error. Rethrowing the underlying network
        // failure here would tell the caller a connection dropped when the user
        // actually pressed Ctrl+C — the exact confusion the old inline retry's
        // dedicated abort message existed to prevent.
        abortError = new Error(ABORT_MESSAGE)
        break
      }
      if (lastClass === "fatal") break
      if (attempt >= maxAttempts) break

      let delay = backoffDelay(attempt, baseDelayMs, maxDelayMs, jitterRatio, random)
      // Retry-After is the SERVER telling us when to come back; it overrides our
      // own schedule. Ignoring it is how a client hammers an endpoint that
      // explicitly asked it to wait. The error's own value wins over the
      // option-level default, and both accept a numeric string.
      const serverSeconds = retryAfterSeconds ?? parseRetryAfter(options.retryAfterSeconds)
      if (serverSeconds !== undefined && Number.isFinite(serverSeconds) && serverSeconds >= 0) {
        delay = Math.min(Math.round(serverSeconds * 1000), maxDelayMs)
      }

      // Stop rather than sleep past the total budget: the point of the budget is
      // to fail loudly in bounded time, not to guarantee `maxAttempts`.
      if (totalTimeoutMs !== undefined) {
        const elapsed = now() - startedAt
        if (elapsed + delay >= totalTimeoutMs) {
          return {
            ok: false,
            error: lastError,
            attempts: attempt,
            elapsedMs: Math.max(0, elapsed),
            delaysMs,
            timedOut: true,
            lastClass,
          }
        }
      }

      delaysMs.push(delay)
      options.onRetry?.({ attempt, delayMs: delay, reason: lastClass, error })
      await sleep(delay)
    }
  }

  return {
    ok: false,
    error: abortError ?? lastError,
    attempts: maxAttempts > 0 ? delaysMs.length + 1 : 0,
    elapsedMs: Math.max(0, now() - startedAt),
    delaysMs,
    timedOut: false,
    lastClass,
  }
}

/** A tiny circuit breaker, for a dependency that is failing in a sustained way.
 *
 *  `withRetry` bounds the damage from ONE call. When every turn pays the full
 *  backoff schedule against a dead endpoint, the user waits out the same seconds
 *  forever. After `threshold` consecutive failures the breaker opens and fails
 *  fast until `resetAfterMs` has passed.
 */
export class CircuitBreaker {
  private failures = 0
  private openedAt: number | null = null

  constructor(
    private readonly threshold: number,
    private readonly resetAfterMs: number,
    private readonly now: () => number = (): number => Date.now(),
  ) {}

  /** True when a call would be short-circuited right now. */
  isOpen(): boolean {
    if (this.openedAt === null) return false
    if (this.now() - this.openedAt >= this.resetAfterMs) {
      // Cooldown elapsed: half-open, so one probe gets through.
      //
      // The failure counter is DELIBERATELY NOT reset here. It stays at the
      // threshold, so a single further failure re-opens immediately. Resetting it
      // to 0 meant the probe had to be followed by `threshold` more failures
      // before the endpoint was protected again — so a still-dead dependency
      // received a burst of `threshold` calls every cooldown window, which is
      // exactly the traffic pattern a breaker exists to prevent.
      this.openedAt = null
      return false
    }
    return true
  }

  /** Record a success: the endpoint is healthy, reset everything. */
  recordSuccess(): void {
    this.failures = 0
    this.openedAt = null
  }

  /** Record a failure; opens the breaker once `threshold` is reached. */
  recordFailure(): void {
    this.failures += 1
    if (this.failures >= this.threshold) this.openedAt = this.now()
  }

  get failureCount(): number {
    return this.failures
  }

  get isOpenNow(): boolean {
    return this.isOpen()
  }

  /** Milliseconds until the breaker would close, or 0 when already closed. */
  retryAfterMs(): number {
    if (this.openedAt === null) return 0
    return Math.max(0, this.resetAfterMs - (this.now() - this.openedAt))
  }
}