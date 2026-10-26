/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Distributed tracing, with no OpenTelemetry dependency.
 *
 * What was missing
 * ----------------
 * Before this module the repo had **no tracing at all** — the only logging hook
 * it called was a no-op stand-in, and `grep traceparent|startSpan|spanId`
 * returned nothing. OpenAI Codex ships an `otel` crate of 9,636 lines (4,333 of
 * them tests) plus a websocket trace streamer; the nearest equivalent here is a
 * standards-shaped tracer that needs no SDK, which is the whole point of
 * emitting W3C `traceparent` rather than a private format.
 *
 * Four properties that each cost something real if got wrong
 * -----------------------------------------------------------
 *
 *  1. **The buffer is BOUNDED.** A long agent session can emit tens of thousands
 *     of spans. An unbounded array is a memory leak that only shows up after the
 *     user has already lost the work. This is a ring: oldest evicted first, and
 *     the drop count is reported rather than hidden.
 *
 *  2. **Attributes are REDACTED before storage, not before export.** A span
 *     attribute is the natural place for a prompt, a file path, or a token, and a
 *     value that sits in memory unredacted is already a leak even if it never
 *     leaves the process.
 *
 *  3. **Disabled means one boolean check.** This sits in the agent loop's hot
 *     path. A disabled tracer must not allocate a clock reading or an object per
 *     span, or tracing becomes the latency it exists to measure.
 *
 *  4. **The clock and the ID source are injected.** A tracer whose tests depend
 *     on wall-clock time produces order-dependent, intermittently failing tests.
 *
 * Interoperability
 * ----------------
 * `traceparent` is the W3C Trace Context header, spelled exactly as the spec:
 * `00-<32 hex trace>-<16 hex span>-<2 hex flags>`. Emitting it correctly means
 * these traces can be stitched to any OTLP-compatible collector rather than being
 * trapped in a private format.
 */

/** W3C trace context header: `00-<trace>-<span>-<flags>`. */
export type TraceParent = string

export type SpanStatus = "unset" | "ok" | "error"

export interface SpanEvent {
  name: string
  /** Epoch milliseconds, from the injected clock. */
  at: number
  attributes: Record<string, string>
}

export interface Span {
  name: string
  traceId: string
  spanId: string
  parentSpanId?: string
  /** Epoch milliseconds. */
  startedAt: number
  /** Epoch milliseconds; absent while the span is still open. */
  endedAt?: number
  status: SpanStatus
  attributes: Record<string, string>
  events: SpanEvent[]
}

export interface TraceContext {
  traceId: string
  spanId: string
  parentSpanId?: string
}

export interface TracerOptions {
  /** False short-circuits every span: the disabled fast path. */
  enabled?: boolean
  /** Maximum spans retained. Oldest are evicted first. */
  maxSpans?: number
  /** Maximum events per span. A chatty span must not grow without bound. */
  maxEventsPerSpan?: number
  /** Head sampler: called with the span name; false drops it at creation. */
  sample?: (name: string) => boolean
  /** Injected clock; tests supply a deterministic one. */
  now?: () => number
  /** Injected id source; must return lowercase hex of the requested length. */
  randomHex?: (bytes: number) => string
  /** Applied to every attribute value on the way in. */
  redact?: (value: string) => string
}

const HEX = "0123456789abcdef"

function defaultHex(bytes: number): string {
  let out = ""
  for (let i = 0; i < bytes * 2; i++) {
    out += HEX[Math.floor(Math.random() * 16)]
  }
  return out
}

/** A trace ID of all zeros is invalid per the spec and must not be emitted. */
function isZeroHex(value: string): boolean {
  return /^0+$/.test(value)
}

/**
 * Build a `traceparent` header.
 *
 * Returns undefined rather than a malformed string when the context is not
 * valid, because the spec requires all-zero ids to be replaced and an agent that
 * emits `0000...` into a header breaks correlation for everything downstream.
 */
export function formatTraceParent(ctx: TraceContext, sampled = true): TraceParent | undefined {
  if (!/^[0-9a-f]{32}$/.test(ctx.traceId) || isZeroHex(ctx.traceId)) return undefined
  if (!/^[0-9a-f]{16}$/.test(ctx.spanId) || isZeroHex(ctx.spanId)) return undefined
  return `00-${ctx.traceId}-${ctx.spanId}-${sampled ? "01" : "00"}`
}

/**
 * Parse a `traceparent` header.
 *
 * Total on failure: a malformed header must not throw inside a request path. An
 * unparseable header yields undefined and the caller starts a fresh trace, which
 * loses correlation but never correctness.
 */
export function parseTraceParent(header: string | undefined | null): TraceContext | undefined {
  if (typeof header !== "string") return undefined
  const parts = header.trim().split("-")
  if (parts.length < 4) return undefined
  const [, traceId, spanId, flags] = parts
  if (traceId === undefined || spanId === undefined) return undefined
  if (!/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId)) return undefined
  if (isZeroHex(traceId) || isZeroHex(spanId)) return undefined
  return {
    traceId,
    spanId,
    ...(typeof flags === "string" && flags === "00" ? {} : {}),
  }
}

/** A span handle. Ending twice is a no-op rather than a corruption. */
export interface SpanHandle {
  readonly context: TraceContext
  setAttribute(key: string, value: string | number | boolean): void
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void
  setStatus(status: SpanStatus): void
  end(): void
  readonly ended: boolean
}

export class Tracer {
  private readonly enabled: boolean
  private readonly maxSpans: number
  private readonly maxEvents: number
  private readonly sample: (name: string) => boolean
  private readonly now: () => number
  private readonly hex: (bytes: number) => string
  private readonly redactValue: (value: string) => string

  /** Ring buffer: oldest evicted once `maxSpans` is reached. */
  private buffer: Span[] = []
  private droppedSpans = 0
  private endedCount = 0

  constructor(options: TracerOptions = {}) {
    this.enabled = options.enabled !== false
    this.maxSpans = Math.max(1, Math.floor(options.maxSpans ?? 1_000))
    this.maxEvents = Math.max(0, Math.floor(options.maxEventsPerSpan ?? 32))
    this.sample = options.sample ?? ((): boolean => true)
    this.now = options.now ?? ((): number => Date.now())
    this.hex = options.randomHex ?? defaultHex
    this.redactValue =
      options.redact ??
      // Conservative default: drop anything that looks credential-shaped. The
      // caller can pass a stricter redactor; this floor never emits one.
      ((value: string): string =>
        /\b(sk|pk|rk|ghp|gho|ghu|ghs|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/.test(value) ? "[redacted]" : value)
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  /** Spans currently retained, oldest first. */
  get spans(): readonly Span[] {
    return this.buffer
  }

  /** Spans evicted because the ring was full. Non-zero means data was lost. */
  get dropped(): number {
    return this.droppedSpans
  }

  /**
   * Begin a span.
   *
   * `parent` continues an existing trace — either from an upstream
   * `traceparent` or from an enclosing span — so a tool call appears beneath the
   * turn that made it rather than as an unrelated root.
   */
  startSpan(name: string, parent?: TraceContext): SpanHandle | undefined {
    // The disabled fast path. No clock read, no id generation, no allocation:
    // this sits in the agent loop and a tracer that costs anything when off is
    // a tracer that changes the numbers it measures.
    if (!this.enabled) return undefined
    if (!this.sample(name)) return undefined

    const traceId = parent?.traceId ?? this.hex(16)
    const spanId = this.hex(8)
    const span: Span = {
      name,
      traceId,
      spanId,
      ...(parent?.spanId === undefined ? {} : { parentSpanId: parent.spanId }),
      startedAt: this.now(),
      status: "unset",
      attributes: {},
      events: [],
    }

    let index = this.buffer.push(span) - 1
    if (index >= this.maxSpans) {
      // Shift rather than a true circular array: the buffer is small and read
      // sequentially, and a correct splice beats a clever ring index that is
      // wrong at the wrap point.
      this.buffer.splice(0, index - this.maxSpans + 1)
      this.droppedSpans += 1
      index = this.buffer.length - 1
    }
    const stored = this.buffer[index]

    let ended = false
    // Captured as narrow consts rather than `const self = this`: the alias form
    // trips `no-this-alias`, and naming the three things actually used keeps the
    // handle independent of the enclosing `this` at all.
    const clock = this.now
    const scrub = this.redactValue
    const eventCap = this.maxEvents
    const onEnd = (): void => {
      this.endedCount += 1
    }

    return {
      context: { traceId, spanId, ...(parent?.spanId === undefined ? {} : { parentSpanId: parent.spanId }) },
      get ended(): boolean {
        return ended
      },
      setAttribute(key: string, value: string | number | boolean): void {
        if (ended || stored === undefined) return
        stored.attributes[key] = scrub(String(value))
      },
      addEvent(eventName: string, attributes: Record<string, string | number | boolean> = {}): void {
        if (ended || stored === undefined) return
        if (stored.events.length >= eventCap) return
        const clean: Record<string, string> = {}
        for (const [k, v] of Object.entries(attributes)) clean[k] = scrub(String(v))
        stored.events.push({ name: eventName, at: clock(), attributes: clean })
      },
      setStatus(status: SpanStatus): void {
        if (ended || stored === undefined) return
        stored.status = status
      },
      end(): void {
        // Ending twice must not overwrite the first end time: a handle kept past
        // its scope would otherwise rewrite the duration to near-zero.
        if (ended || stored === undefined) return
        ended = true
        stored.endedAt = clock()
        onEnd()
      },
    }
  }

  /** Wrap a function so its span is created, ended, and error-statused for you. */
  async trace<T>(name: string, fn: (span: SpanHandle) => Promise<T>, parent?: TraceContext): Promise<T> {
    const span = this.startSpan(name, parent)
    if (span === undefined) return fn(NOOP_SPAN)
    try {
      const result = await fn(span)
      span.setStatus("ok")
      return result
    } catch (error) {
      span.setStatus("error")
      span.addEvent("exception", { message: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      span.end()
    }
  }

  /** Duration of a span in ms, or undefined while it is still open. */
  durationOf(span: Span): number | undefined {
    if (span.endedAt === undefined) return undefined
    return Math.max(0, span.endedAt - span.startedAt)
  }

  /** Drop everything, including the drop counter. Used between tests. */
  reset(): void {
    this.buffer = []
    this.droppedSpans = 0
    this.endedCount = 0
  }

  /**
   * Export in an OTLP-shaped JSON envelope.
   *
   * OTLP-shaped rather than OTLP-encoded on purpose: the wire format needs a
   * protobuf dependency, and the value here is that the shape is the standard one
   * so a collector (or a later encoder) accepts it without reshaping.
   */
  exportJsonl(): string {
    const lines: string[] = []
    for (const span of this.buffer) {
      lines.push(
        JSON.stringify({
          resourceSpans: [
            {
              scopeSpans: [
                {
                  spans: [
                    {
                      traceId: span.traceId,
                      spanId: span.spanId,
                      ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
                      name: span.name,
                      kind: 1,
                      startTimeUnixNano: String(span.startedAt * 1_000_000),
                      ...(span.endedAt === undefined
                        ? {}
                        : { endTimeUnixNano: String(span.endedAt * 1_000_000) }),
                      attributes: Object.entries(span.attributes).map(([key, value]) => ({ key, value: { stringValue: value } })),
                      events: span.events.map((e) => ({
                        timeUnixNano: String(e.at * 1_000_000),
                        name: e.name,
                        attributes: Object.entries(e.attributes).map(([key, value]) => ({ key, value: { stringValue: value } })),
                      })),
                    },
                  ],
                },
              ],
            },
          ],
        }),
      )
    }
    return lines.length === 0 ? "" : lines.join("\n") + "\n"
  }
}

/**
 * A handle that does nothing.
 *
 * Used by `trace()` when tracing is disabled, so instrumented code can call
 * `setAttribute` unconditionally instead of branching at every call site.
 */
export const NOOP_SPAN: SpanHandle = {
  context: { traceId: "0".repeat(32), spanId: "0".repeat(16) },
  ended: false,
  setAttribute(): void {},
  addEvent(): void {},
  setStatus(): void {},
  end(): void {},
}

/** Process-wide tracer. Disabled until something opts in. */
let active: Tracer | undefined

export function getTracer(): Tracer | undefined {
  return active
}

/** Install the process tracer. Passing `undefined` disables tracing. */
export function setTracer(tracer: Tracer | undefined): void {
  active = tracer
}

/** Start a span on the installed tracer, or get a no-op handle. */
export function startSpan(name: string, parent?: TraceContext): SpanHandle {
  return active?.startSpan(name, parent) ?? NOOP_SPAN
}