/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Socket-level network policy: the part of the sandbox that decides what a
 * connection is allowed to do, rather than what a command line says it will do.
 *
 * Why this exists
 * ---------------
 * `network-policy.ts` reads the command text. That is a real control and it is not
 * nothing — it catches `curl https://blocked.example` before a process exists. It
 * is also, necessarily, defeatable, and the holes are structural rather than
 * incidental:
 *
 *  - A destination assembled at runtime (`curl "http://$H"` where `$H` was built
 *    two commands ago) is not in the text at all.
 *  - An interpreter that opens a socket never mentions a domain (`node -e
 *    'require("net").connect(443,"x")'`).
 *  - **Most importantly: a domain allow-list or deny-list says nothing about IP
 *    literals.** `169.254.169.254` matches no domain entry, so under a deny-list
 *    — the default posture, since an empty allow-list means "everything" — the
 *    cloud instance-metadata endpoint is reachable, and that endpoint hands out
 *    the credentials of the machine the agent is running on.
 *
 * That last one is a hole in the design rather than in the implementation, which
 * is why no amount of tuning the text scan closes it. This module closes it, and
 * then goes on to give the allow-list something to be enforced *against*.
 *
 * The enforcement model
 * ---------------------
 * Three layers, weakest to strongest, and this file owns the middle one:
 *
 *  1. **Text scan** (`network-policy.ts`) — before the process starts. Cheap,
 *     no network, catches the ordinary case.
 *  2. **Route table** (this file) — the authoritative per-connection decision.
 *     Pure and total: every host maps to exactly one of allow / deny, with a
 *     stated reason, and "no rule matched" is a DENY under an allow-list.
 *  3. **Namespace** (`spawn.ts`) — `--unshare-net` removes the network entirely.
 *     Strongest, and also all-or-nothing: it cannot express "example.com yes,
 *     everything else no".
 *
 * Layer 3 already exists. What it could not express is the reason most callers do
 * not want it: an agent that must reach one API host should not have to have all
 * networking switched off to get it, and an all-or-nothing switch gets turned off
 * entirely the first time a tool needs the network.
 *
 * `routeTableFor` is what the caller enforces — over a proxy, over a netfilter
 * chain, or by rewriting the namespace's egress. The decision function is
 * deliberately total and deliberately has no I/O, so the layer that enforces it
 * can be swapped without the policy being able to drift from what was reviewed.
 */

import { ManagedProxyConfig } from "./types.js"

/* ------------------------------------------------------------------ *
 * Address classification
 * ------------------------------------------------------------------ */

/** Why an address is refused regardless of the domain lists. */
export type AddressVerdict = "ok" | "loopback" | "link-local" | "private" | "unspecified" | "malformed"

const VERDICT_REASON: Record<AddressVerdict, string> = {
  ok: "",
  loopback: "loopback address",
  // 169.254.169.254 is the AWS/GCP/Azure instance-metadata endpoint. It hands
  // out short-lived credentials for the machine the agent runs on, which turns
  // "can make HTTP requests" into "can read the host's cloud identity". It is
  // link-local, so it is caught by the same rule rather than special-cased —
  // a hardcoded address list is a list that ages badly.
  "link-local": "link-local address (includes cloud instance metadata at 169.254.169.254)",
  private: "private address",
  unspecified: "unspecified address",
  malformed: "malformed address",
}

/** IPv4 in dotted-quad form, or null. Deliberately strict: 4 decimal octets, no shorthand. */
function parseIpv4(value: string): number[] | null {
  const parts = value.split(".")
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const p of parts) {
    // Reject `01`, empty octets and non-digits. `010` parses as 10 in several
    // resolvers and 8 in others, and a filter that disagrees with the resolver
    // about what `010.0.0.1` means is a filter that can be walked past.
    if (!/^\d{1,3}$/.test(p)) return null
    if (p.length > 1 && p.startsWith("0")) return null
    const n = Number(p)
    if (n > 255) return null
    out.push(n)
  }
  return out
}

/**
 * Classify a host as an address literal rather than a domain name.
 *
 * Returns `undefined` for a name, and the verdict for a literal. Keeping these
 * separate matters: a domain that happens to look numeric is not an address, and
 * treating it as one would deny a legitimate host on the strength of its spelling.
 */
export function classifyHost(host: string): AddressVerdict | undefined {
  const h = host.trim().toLowerCase()
  if (h.length === 0) return "malformed"

  if (h.startsWith("[")) {
    if (!h.endsWith("]")) return "malformed"
    return classifyIpv6(h.slice(1, -1))
  }
  const v4 = parseIpv4(h)
  if (v4) return classifyIpv4(v4)
  // An all-numeric dotted form that failed to parse is an address someone meant
  // to write, not a domain name. Falling through to the name branch would treat
  // `010.0.0.1` as a hostname, match no rule under an open table, and allow it.
  if (/^\d+(\.\d+)+$/.test(h)) return "malformed"
  // A colon means IPv6 only for a bare address. `https://host/` has colons too,
  // and routing that into the IPv6 classifier calls it malformed — refusing
  // every URL passed un-normalized.
  if (h.includes(":") && !/[/?#@]/.test(h)) return classifyIpv6(h)
  return undefined
}

function classifyIpv4(octets: number[]): AddressVerdict {
  const [a, b] = octets as [number, number, number, number]
  if (a === 127) return "loopback"
  if (a === 0) return "unspecified"
  if (a === 169 && b === 254) return "link-local"
  if (a === 10) return "private"
  if (a === 172 && b >= 16 && b <= 31) return "private"
  if (a === 192 && b === 168) return "private"
  // 100.64.0.0/10 — carrier-grade NAT. Not RFC1918, but it is never a public
  // destination and is the range cloud providers hand out internally.
  if (a === 100 && b >= 64 && b <= 127) return "private"
  // 169.254.0.0/16 is link-local; the catch-all below keeps the rule readable.
  if (a >= 224 && a <= 239) return "private"
  return "ok"
}

function classifyIpv6(value: string): AddressVerdict {
  const v = value.trim().toLowerCase()
  if (v.length === 0) return "malformed"
  // `::` is the unspecified address and all-zero forms collapse to it.
  if (/^0{0,4}(:0{0,4})*:0{0,4}(:0{0,4})*$/.test(v) || v === "::") return "unspecified"
  if (v === "::1" || v === "0:0:0:0:0:0:0:1") return "loopback"
  if (v.startsWith("fe80")) return "link-local"
  if (v.startsWith("fc") || v.startsWith("fd")) return "private"
  // IPv4-mapped: `::ffff:169.254.169.254` reaches the same endpoint as the bare
  // address. Without this, the bracket form of the metadata endpoint is a
  // one-character bypass of the IPv4 rule.
  const mapped = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(v)
  if (mapped) return classifyIpv4(parseIpv4(mapped[1] as string) ?? [])
  // Anything that is not parseable as an address we recognise is refused rather
  // than allowed: a filter that passes what it cannot classify is not a filter.
  if (!/^[0-9a-f:.]+$/.test(v)) return "malformed"
  return "ok"
}

/** Human-readable explanation for a non-`ok` verdict. */
export function addressVerdictReason(verdict: AddressVerdict): string {
  return VERDICT_REASON[verdict]
}

/**
 * Whether a literal address is refused whatever the domain lists say.
 *
 * Exported separately from `classifyHost` so the guard can be applied to a
 * destination that never went through the text scan — an interpreter opening a
 * socket directly never produces a host for `classifyHost` to classify, and the
 * caller reaches this with whatever the connection actually resolved to.
 */
export function isRefusedAddress(host: string): boolean {
  const v = classifyHost(host)
  return v !== undefined && v !== "ok"
}

/* ------------------------------------------------------------------ *
 * Route table
 * ------------------------------------------------------------------ */

/** One ordered decision rule. */
export interface RouteRule {
  /** The domain entry, already normalized. Empty means "the default rule". */
  domain: string
  allow: boolean
  /** Why this rule exists, for the violation message and for review. */
  why: string
}

export interface RouteTable {
  /** True when no allow-list is configured, i.e. the default is allow. */
  openByDefault: boolean
  /** Deny rules first, then allow rules, then the single default rule. */
  rules: RouteRule[]
  /** Whether IP literals are refused outright, independent of the lists. */
  refuseAddresses: boolean
}

export interface RoutePolicy {
  allowedDomains: readonly string[]
  blockedDomains: readonly string[]
  /** When true, nothing is reachable and the table is a single deny. */
  disableNetwork?: boolean
  /** Defaults to true. Turning it off re-opens the metadata endpoint. */
  refuseAddresses?: boolean
}

/**
 * Build the authoritative decision table.
 *
 * Ordering is deny-first and it is load-bearing: `blockedDomains` "takes
 * precedence over `allowedDomains`" is only true if the evaluation honours it, and
 * an allow-first table would make that sentence a lie the moment a host appeared
 * in both lists. Building the order here rather than leaving it to whoever writes
 * the evaluator means the precedence cannot be got wrong downstream.
 *
 * The default rule is always last and always present. "No rule matched" resolving
 * to nothing is how an allow-list silently becomes an observation.
 */
export function routeTableFor(policy: RoutePolicy): RouteTable {
  const refuseAddresses = policy.refuseAddresses !== false

  if (policy.disableNetwork === true) {
    return {
      openByDefault: false,
      refuseAddresses,
      rules: [{ domain: "", allow: false, why: "network disabled by policy" }],
    }
  }

  const hasAllow = policy.allowedDomains.length > 0
  const rules: RouteRule[] = []

  for (const entry of policy.blockedDomains) {
    rules.push({ domain: normalizeForRoute(entry), allow: false, why: "blocked domain" })
  }
  for (const entry of policy.allowedDomains) {
    rules.push({ domain: normalizeForRoute(entry), allow: true, why: "allowed domain" })
  }
  rules.push({
    domain: "",
    allow: !hasAllow,
    why: hasAllow ? "not in the allowed domain list" : "no allow-list configured",
  })

  return { openByDefault: !hasAllow, refuseAddresses, rules }
}

/** Strip a scheme, credentials, port, path and trailing dot; lowercase. */
function normalizeForRoute(value: string): string {
  let v = value.trim().toLowerCase()
  if (v.length === 0) return ""
  const scheme = v.indexOf("://")
  if (scheme >= 0) v = v.slice(scheme + 3)
  else if (v.startsWith("//")) v = v.slice(2)
  const at = v.lastIndexOf("@")
  if (at >= 0) v = v.slice(at + 1)
  const bracketClose = v.indexOf("]")
  const colon = bracketClose >= 0 ? v.indexOf(":", bracketClose) : v.indexOf(":")
  if (colon >= 0) v = v.slice(0, colon)
  const cut = v.search(/[/?#]/)
  if (cut >= 0) v = v.slice(0, cut)
  if (v.endsWith(".")) v = v.slice(0, -1)
  return v
}

/** The decision, with the reason it came out that way. */
export interface RouteDecision {
  allow: boolean
  /** The rule index that decided it. `null` only when the table is empty. */
  ruleIndex: number | null
  /** Present when the decision was an address refusal rather than a list match. */
  addressVerdict?: AddressVerdict
  /** One line, suitable for a violation message. */
  reason: string
}

/**
 * Decide one destination.
 *
 * Total: every input returns a decision, and no input returns "unknown". An
 * enforcement hook that can fail to produce an answer will eventually produce no
 * answer, and the natural default for that is allow.
 */
export function decideRoute(host: string, table: RouteTable): RouteDecision {
  // Normalise BEFORE classifying. Classifying first sends `https://example.com/`
  // into the IPv6 branch on its scheme colon and refuses every URL the caller
  // hands in, which looks like a broken filter rather than a misordered pair of
  // operations.
  const h = normalizeForRoute(host)

  if (table.refuseAddresses) {
    const verdict = classifyHost(h)
    if (verdict !== undefined && verdict !== "ok") {
      return {
        allow: false,
        ruleIndex: null,
        addressVerdict: verdict,
        reason: `${host} refused: ${VERDICT_REASON[verdict]}`,
      }
    }
  }

  // An empty destination cannot match an allow-list, and matching the default is
  // the right answer: under an open table it is meaningless, under a closed one
  // it must not be allowed.
  for (let i = 0; i < table.rules.length; i++) {
    const rule = table.rules[i] as RouteRule
    if (rule.domain === "") {
      return { allow: rule.allow, ruleIndex: i, reason: rule.why }
    }
    if (h.length > 0 && (h === rule.domain || h.endsWith("." + rule.domain))) {
      return { allow: rule.allow, ruleIndex: i, reason: rule.why }
    }
  }

  // Unreachable for a table built by `routeTableFor`, which always ends with the
  // default rule. Denied rather than allowed so that a truncated or hand-built
  // table fails closed.
  return { allow: false, ruleIndex: null, reason: "no matching rule" }
}

/* ------------------------------------------------------------------ *
 * Enforcement wiring
 * ------------------------------------------------------------------ */

/** Why an endpoint could not be built. */
export type EndpointProblem =
  | "fixed-port"
  | "insecure-transport"
  | "unparseable-url"
  | "missing-url"
  | "no-upstream"

/**
 * Plan for the managed proxy that a namespace routes through.
 *
 * A network namespace with no route out cannot reach a proxy running outside it.
 * The mechanism is a loopback alias plumbed in with `slirp4netns`-style userspace
 * networking, or a veth pair into the parent namespace; either way the in-sandbox
 * address is fixed by the mechanism. That is why `port` must be asked for, not
 * chosen.
 */
export interface ProxyEndpoint {
  /** Host the sandbox connects to. Loopback, since it is reached from inside. */
  host: string
  port: number
  /** The upstream the parent-side proxy itself forwards to, if configured. */
  upstream?: string
  /** Set when the endpoint is usable. */
  problem?: EndpointProblem
  /** One line, for the caller to surface or to log. */
  detail: string
}

/**
 * Build the endpoint plan, or explain why there is not one.
 *
 * Every rejection here is a decision not to silently substitute a default. A
 * proxy pointed at a fixed port is a port another process on the host can bind
 * first and receive the sandbox's traffic; a proxy with no CA bundle is a TLS
 * interceptor that cannot be verified; both are worse than no proxy, because the
 * caller believes they have one.
 */
export function proxyEndpoint(config: ManagedProxyConfig | undefined, port: number): ProxyEndpoint {
  if (!config || config.url.trim().length === 0) {
    return {
      host: "",
      port: 0,
      problem: "missing-url",
      detail: "no proxy url configured; sandbox traffic stays inside the namespace",
    }
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return {
      host: "",
      port: 0,
      problem: "fixed-port",
      detail: `no usable proxy port (got ${port}); a fixed port can be pre-bound by another host process`,
    }
  }
  let parsed: URL
  try {
    parsed = new URL(config.url)
  } catch {
    return { host: "", port: 0, problem: "unparseable-url", detail: `proxy url is not a URL: ${config.url}` }
  }
  if (parsed.protocol !== "https:") {
    // The proxy is the thing that now sees every byte the sandbox sends. Plain
    // HTTP makes that observable to anything on the host's loopback.
    return {
      host: parsed.hostname,
      port,
      problem: "insecure-transport",
      detail: "proxy transport is not https; traffic to it would be readable on the host loopback",
    }
  }
  if (!config.caBundlePath || config.caBundlePath.trim().length === 0) {
    // An https proxy with no CA bundle either fails every handshake or, worse,
    // is run with verification disabled to make it work.
    return {
      host: parsed.hostname,
      port,
      problem: "no-upstream",
      detail: "https proxy has no caBundlePath; interception cannot be verified",
    }
  }
  return {
    host: parsed.hostname,
    port,
    upstream: parsed.origin,
    detail: `proxy at ${parsed.origin}:${port}`,
  }
}

/**
 * Whether a hardened sandbox may be considered protected by this table.
 *
 * Named so the honest answer is hard to state by accident. It is false whenever
 * the table is open by default AND addresses are not refused, which is the
 * default posture of a caller who never configured anything: in that state the
 * table is documentation, not enforcement.
 */
export function tableIsEnforcing(table: RouteTable): boolean {
  return !table.openByDefault || table.refuseAddresses || table.rules.some((r) => !r.allow)
}