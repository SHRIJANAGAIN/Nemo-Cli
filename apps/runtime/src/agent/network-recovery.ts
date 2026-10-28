/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Network-outage detection and auto-resume (#124).
 *
 * A provider error has two very different causes that look identical to a
 * naive retry loop:
 *
 *  - The SERVER is unhappy: 429, 503, a gateway timeout. It recovers on its
 *    own schedule, so bounded exponential backoff is exactly right.
 *  - The LOCAL NETWORK is down: a refused socket, an unresolvable host, an
 *    unreachable interface. Retrying into it accomplishes nothing except
 *    spending the retry budget, and when the budget runs out the run dies even
 *    though the network came back a second later.
 *
 * The second case is the one users actually hit — a sleeping laptop, a VPN
 * re-authenticating, a captive-portal wifi. So a network-class failure parks
 * the turn and PROBES until the endpoint answers again, instead of counting
 * down a budget that was sized for the wrong problem.
 *
 * Probing the provider's own base URL (rather than a public site) keeps the
 * signal honest: it answers exactly the question being asked, which is "can I
 * reach the thing I need".
 */

import * as http from "http"
import * as https from "https"

export type NetworkOutcome = "restored" | "timeout" | "aborted"

export interface WaitForNetworkOptions {
  /** Endpoint whose reachability answers the question. */
  probeUrl: string
  /** Gap between probes. Default 3s, matching the observed outage cadence. */
  intervalMs?: number
  /** Give up after this long. Default 5 minutes — longer than the retry budget
   *  on purpose, because a real outage outlives a 120s window. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Called after every probe attempt (tests assert the retry actually loops). */
  onProbe?: (attempt: number, reachable: boolean) => void
  /** Called once per state transition, so the UI can say what is happening. */
  onState?: (state: NetworkOutcome) => void
  /** Per-probe request timeout. Default 5s — a probe must never hang the run. */
  probeTimeoutMs?: number
}

/**
 * Socket-level failures that mean nothing is answering on this machine.
 *
 * Deliberately EXCLUDES anything carrying an HTTP status: a 504/408 is the
 * gateway's own timeout and the network is demonstrably fine, so parking the
 * turn would hide a server problem behind a "waiting for network" message.
 */
const OUTAGE_PATTERNS = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /EPIPE/i,
  /EHOSTUNREACH/i,
  /ENETUNREACH/i,
  /ENETDOWN/i,
  /EAI_AGAIN/i,
  /\bENOTFOUND\b/i,
  /\bETIMEDOUT\b/i,
  /socket hang up/i,
  /connection (closed|reset|refused)/i,
  /network (is )?(unreachable|down)/i,
  /getaddrinfo/i,
  /EPROTO/i,
  /EHOSTDOWN/i,
]

/**
 * An HTTP status in the text means a server answered — so it is NOT an outage.
 *
 * The `(?<!:)` guard is load-bearing: `ECONNREFUSED 127.0.0.1:443` is the single
 * most common outage message there is, and a naive `\b(4\d{2}|5\d{2})\b` reads
 * its PORT as a status code and then classifies a dead socket as a healthy
 * server. Anything directly after a colon is a port or a path, never a status.
 */
const STATUS_IN_TEXT = /(?<!:)\b(4\d{2}|5\d{2})\b/

export function isNetworkOutage(raw: string): boolean {
  const text = raw ?? ""
  if (STATUS_IN_TEXT.test(text)) return false
  return OUTAGE_PATTERNS.some((re) => re.test(text))
}

/** One short probe. Any HTTP answer counts as reachable — the port is up. */
function probeOnce(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      done(/*reachable*/ false)
      return
    }
    const client = parsed.protocol === "https:" ? https : http
    const req = client.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: "/",
        method: "GET",
      },
      (res) => {
        res.resume() // drain, we only care that the connection worked
        done(/*reachable*/ true)
      },
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      done(/*reachable*/ false)
    })
    req.on("error", () => done(/*reachable*/ false))
    req.end()
  })
}

/** Abort-aware sleep: a long wait must never outlive a Ctrl+C. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(/*completed*/ false)
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve(/*completed*/ true)
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(/*completed*/ false)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Block until `probeUrl` answers, the deadline passes, or the run is aborted.
 *
 * Emits exactly one terminal state so a caller can log/report it without
 * tracking transitions itself.
 */
export async function waitForNetwork(opts: WaitForNetworkOptions): Promise<NetworkOutcome> {
  // No endpoint to probe means no way to ever observe recovery. Parking here
  // would burn the whole outage budget proving nothing, so report the timeout
  // immediately and let the caller surface the original error.
  if (typeof opts.probeUrl !== "string" || opts.probeUrl.trim().length === 0) return "timeout"
  const interval = opts.intervalMs ?? 3_000
  const timeout = opts.timeoutMs ?? 300_000
  const probeTimeout = opts.probeTimeoutMs ?? 5_000
  const deadline = Date.now() + timeout
  let attempt = 0
  let announced: NetworkOutcome | undefined

  const finish = (outcome: NetworkOutcome): NetworkOutcome => {
    if (announced === undefined) {
      announced = outcome
      opts.onState?.(outcome)
    }
    return announced
  }

  for (;;) {
    if (opts.signal?.aborted) return finish("aborted")
    attempt++
    const reachable = await probeOnce(opts.probeUrl, probeTimeout)
    opts.onProbe?.(attempt, reachable)
    if (reachable) return finish("restored")
    if (Date.now() >= deadline) return finish("timeout")
    if (!(await sleep(interval, opts.signal))) return finish("aborted")
  }
}
