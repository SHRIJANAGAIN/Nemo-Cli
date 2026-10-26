/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Proxy environment for a sandboxed process — the part that makes the route
 * table mean something.
 *
 * The gap this closes
 * -------------------
 * `proxy-routing.ts` decides, per destination, whether a connection is allowed.
 * That decision has to be consulted by something the sandboxed process actually
 * talks to. Today nothing forces it to be.
 *
 * The specific hole: a sandboxed process inherits the host's proxy environment.
 * `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` point at whatever proxy the user
 * runs — a corporate egress proxy, a local MITM, anything. The sandboxed process
 * connects there, that proxy resolves the name and opens the socket, and
 * `decideRoute` — which lives in *our* process, looking at command text — never
 * sees it. The allow-list is fully bypassed by a single inherited env var.
 *
 * So a route table with a proxy endpoint configured has to REWRITE the
 * environment to point at the sandbox's own bridge, not merely exist. This module
 * is that rewrite, and it is deliberately conservative about when it applies.
 *
 * What it does NOT do
 * -------------------
 * It does not create a bridge, open a socket, or move a file descriptor across a
 * namespace boundary. Codex does that in Rust (`linux-sandbox/src/proxy_routing.rs`:
 * a Unix-socket FD handoff plus netns route activation). Reimplementing that in
 * TypeScript would be a plausible-looking stub, and a stub that compiles is worse
 * than an honest boundary — so the bridge is injected and the gap is named in the
 * type that the caller has to satisfy.
 *
 * The failure direction is the one that matters: with no usable bridge, the
 * correct outcome is to REMOVE the inherited proxy variables rather than pass them
 * through. An agent with no proxy cannot reach the network; an agent pointed at
 * the host's proxy can reach everything that proxy can.
 */

/** Proxy variables that must not survive into a sandbox unchanged. */
export const PROXY_ENV_KEYS: readonly string[] = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "WS_PROXY",
  "WSS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "ws_proxy",
  "wss_proxy",
  "all_proxy",
]

/** `NO_PROXY` is spelled three ways in the wild and all of them are honoured. */
export const NO_PROXY_ENV_KEYS: readonly string[] = ["NO_PROXY", "no_proxy"]

/** Default port per scheme, matching what every HTTP proxy client assumes. */
export function defaultProxyPort(scheme: string): number {
  switch (scheme.toLowerCase()) {
    case "https:":
      return 443
    case "socks:":
    case "socks5:":
    case "socks5h:":
      return 1080
    default:
      return 80
  }
}

/**
 * Whether a host refers to the local machine.
 *
 * Stricter than a string compare, because the check that matters is "would this
 * resolve to me". `localhost`, `127.0.0.1` and `[::1]` qualify; `0.0.0.0` does
 * not, even though it is all-local, because binding and connecting to it are
 * different things and a proxy there is a listener other software may own.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "")
  if (h === "localhost") return true
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true
  // 127.0.0.0/8 is entirely loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/**
 * Parse a proxy URL into its parts.
 *
 * Returns undefined rather than throwing: a malformed value in an environment
 * variable is not an exception worth crashing a spawn over, and the caller
 * handles absence by REMOVING the variable.
 */
export interface ParsedProxy {
  scheme: string
  host: string
  port: number
}

export function parseProxyUrl(url: string): ParsedProxy | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (!parsed.hostname) return undefined
  const port = parsed.port ? Number(parsed.port) : defaultProxyPort(parsed.protocol)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return { scheme: parsed.protocol, host: parsed.hostname, port }
}

/**
 * Rewrite one proxy variable's value to the sandbox bridge endpoint.
 *
 * Returns undefined when the value cannot be rewritten, which the caller treats
 * as "remove this variable". That asymmetry is the whole point: a half-rewritten
 * environment is one where some proxy variables point at the bridge and some at
 * the host, and which one wins depends on the client library.
 */
export function rewriteProxyValue(value: string, bridge: ParsedProxy): string | undefined {
  const original = parseProxyUrl(value)
  // A value that is not a URL at all — a bare `host:port`, or a hostname — is
  // rewritten only when it can be parsed as one. Guessing would produce a URL
  // pointing somewhere the operator did not choose.
  if (!original) {
    const bare = /^(?:https?:\/\/)?([^\s/]+)$/i.exec(value.trim())
    if (!bare) return undefined
    const hostPort = bare[1] as string
    const colon = hostPort.lastIndexOf(":")
    if (colon <= 0) return undefined
    const port = Number(hostPort.slice(colon + 1))
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  }
  return `${bridge.scheme}//${bridge.host}:${bridge.port}`
}

/** A `NO_PROXY` entry that matches `host`. */
export function noProxyMatches(host: string, noProxy: string | undefined): boolean {
  if (!noProxy || noProxy.trim().length === 0) return false
  const h = host.trim().toLowerCase().replace(/\.$/, "")
  if (h.length === 0) return false
  for (const raw of noProxy.split(/[,\s]+/)) {
    const entry = raw.trim().toLowerCase().replace(/^\./, "").replace(/\.$/, "")
    if (entry.length === 0) continue
    // `*` is the conventional "bypass nothing" marker.
    if (entry === "*") return false
    // A bare `.example.com` in NO_PROXY conventionally covers example.com too,
    // so the leading dot is stripped above and matching is segment-aware.
    if (h === entry || h.endsWith(`.${entry}`)) return true
    // A host:port entry only applies to that port.
    if (entry.includes(":")) {
      const bare = entry.slice(0, entry.lastIndexOf(":"))
      if (bare.length > 0 && (h === bare || h.endsWith(`.${bare}`))) return true
    }
  }
  return false
}

/**
 * Merge the environment with the sandbox's proxy configuration.
 *
 * The three outcomes, and only three:
 *
 *  - **Bridge supplied** — every proxy variable is rewritten to it. The host's
 *    proxy stops being reachable from inside the sandbox.
 *  - **No bridge, network unshared** — every proxy variable is REMOVED. There is
 *    no route out, so a proxy URL is at best noise and at worst a way out.
 *  - **No bridge, network NOT unshared** — the variables are LEFT ALONE, and the
 *    result says so. This is the honest state: the sandbox has real egress and
 *    the caller's route table is not what governs it. Silently stripping the
 *    variables here would break every host that needs its proxy, while claiming
 *    isolation it does not have.
 *
 * That third branch is the one worth arguing about, and the reason it is a
 * return value rather than a log line: the caller has to be able to see that its
 * policy is not being enforced at the socket.
 */
export interface ProxyEnvResult {
  env: Record<string, string>
  /** True when every proxy variable points at the sandbox bridge. */
  rewritten: boolean
  /** True when proxy variables were removed because there is no route out. */
  stripped: boolean
  /** True when the host's proxy is still in force and policy is NOT socket-enforced. */
  unenforced: boolean
  /** Why, in one line. Empty when `rewritten` or when nothing was inherited. */
  detail: string
}

export function applyProxyEnv(
  env: Record<string, string>,
  options: {
    /** The in-sandbox bridge, when one exists. */
    bridge?: ParsedProxy
    /** Whether the sandbox has no network at all. */
    networkDisabled: boolean
    /** Whether a route table is expected to govern egress. */
    policyConfigured?: boolean
  },
): ProxyEnvResult {
  const out: Record<string, string> = { ...env }
  const inherited = PROXY_ENV_KEYS.filter((k) => typeof out[k] === "string" && out[k]!.length > 0)

  if (options.bridge) {
    for (const key of inherited) {
      const rewrittenValue = rewriteProxyValue(out[key] as string, options.bridge)
      // A value that cannot be rewritten is DELETED rather than kept: keeping it
      // is how a host proxy survives into a sandbox that has a bridge.
      if (rewrittenValue === undefined) delete out[key]
      else out[key] = rewrittenValue
    }
    return {
      env: out,
      rewritten: true,
      stripped: false,
      unenforced: false,
      detail: inherited.length > 0 ? `rewrote ${inherited.length} proxy variable(s) to the sandbox bridge` : "",
    }
  }

  if (options.networkDisabled) {
    for (const key of inherited) delete out[key]
    // NO_PROXY is dropped too: it only has meaning next to a proxy, and leaving
    // it behind reads as "bypass rules are in effect" when no proxy exists.
    for (const key of NO_PROXY_ENV_KEYS) delete out[key]
    return { env: out, rewritten: false, stripped: inherited.length > 0, unenforced: false, detail: "" }
  }

  return {
    env: out,
    rewritten: false,
    stripped: false,
    unenforced: inherited.length > 0 && options.policyConfigured === true,
    detail:
      inherited.length > 0 && options.policyConfigured === true
        ? "sandbox has egress and the host proxy is still in force; the route table is not enforced at the socket"
        : "",
  }
}