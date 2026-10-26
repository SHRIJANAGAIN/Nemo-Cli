/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Portions derived from OpenAI Codex CLI (codex-rs), Copyright 2025 OpenAI,
 * licensed under the Apache License, Version 2.0. See THIRD_PARTY_NOTICES.md.
 */

import { envBooleanStrict, envList, type EnvSource } from "../../core/src/env_read.js"
import { decideRoute, routeTableFor } from "./proxy-routing.js"

/**
 * Network policy: which hosts a command may reach, and which tools may reach
 * the network at all.
 *
 * What was missing
 * ----------------
 * `NetworkSandboxPolicy.allowedDomains` / `blockedDomains` were declared, typed,
 * and threaded into every `SpawnRequest` — and never consulted by anything.
 * `isNetworkViolation` was re-exported from the package index and called from
 * exactly one file, a test. So a policy naming `blockedDomains: ["evil.test"]`
 * changed no behaviour whatsoever: `curl evil.test` ran identically whether the
 * list was present, empty, or absent.
 *
 * The same gap in the documentation: `AGENTS.md` states *"Tools flagged
 * `isNetworkTool` require explicit approval outside danger mode"*. The symbol
 * `isNetworkTool` appears nowhere in the repository — not in source, not in a
 * test. A rule in the engineering handbook that names a mechanism which does not
 * exist is worse than no rule, because a reviewer trusts that the named
 * mechanism is doing the work.
 *
 * What this can and cannot do
 * ---------------------------
 * This enforces **declared host policy on the command path**, and it is
 * deliberately explicit about the limit.
 *
 * `disableNetwork` is enforced by the kernel — `--unshare-net` for bubblewrap,
 * `(deny network*)` for seatbelt. A command in a network-disabled sandbox has no
 * route out, whatever it names.
 *
 * When network is ENABLED and a domain list is declared, enforcement here is
 * **advisory-by-construction**: it inspects the command text, so it catches the
 * literal destination, and it cannot catch a destination assembled at runtime
 * (`curl "$URL"`, `getent hosts $HOST`, a redirect, a DNS name resolved by the
 * binary itself). Claiming otherwise would be the same class of defect as the
 * `filesystemPolicy` bug: a control that reports success it did not deliver.
 *
 * Closing that gap needs a network proxy that sees actual egress — which is
 * exactly what codex's `network-proxy` crate (28,060 lines, 7,298 of them tests)
 * exists for. That is a large piece of infrastructure, not a shim, so the
 * honest thing is to state the boundary rather than fake a guarantee. A caller
 * that needs hard enforcement should not pass an allow-list and rely on this
 * module; it should pass `disableNetwork: true`.
 *
 * The one thing this does guarantee: with `disableNetwork: true`, or with a
 * declared block-list, a command naming a blocked host is refused BEFORE it is
 * spawned, and the refusal is recorded.
 */

/** The domain policy as the tool layer receives it. */
export interface HostPolicy {
  /** Empty means "any host allowed" unless `disableNetwork` is set. */
  allowedDomains: readonly string[]
  blockedDomains: readonly string[]
  disableNetwork: boolean
}

/**
 * Normalize a host for comparison.
 *
 * Strips a scheme, a port, a path, a trailing dot, and surrounding whitespace,
 * and lowercases. Without the port strip, `example.com:443` and `example.com`
 * compare unequal and a block-list entry silently stops matching — the classic
 * way an allow/deny list degrades into a no-op without anyone noticing.
 */
export function normalizeDomain(value: string): string {
  let v = value.trim().toLowerCase()
  if (v.length === 0) return ""

  // Scheme. `//host` is protocol-relative and appears in redirect targets.
  const scheme = v.indexOf("://")
  if (scheme >= 0) v = v.slice(scheme + 3)
  else if (v.startsWith("//")) v = v.slice(2)

  // Credentials: `https://user:pass@host/` — the host is after the last '@'.
  const at = v.lastIndexOf("@")
  if (at >= 0) v = v.slice(at + 1)

  // Port. An IPv6 literal has colons INSIDE its brackets, so the bracket close
  // is what decides: a colon after the closing `]` is a port, and a colon before
  // it is part of the address. Checking `indexOf("]")` from the first colon
  // instead would find the `]` of `[::1]:8080` and conclude "IPv6, no port",
  // leaving the port attached.
  const bracketClose = v.indexOf("]")
  const colon = bracketClose >= 0 ? v.indexOf(":", bracketClose) : v.indexOf(":")
  if (colon >= 0) v = v.slice(0, colon)

  // Path, query, fragment.
  const cut = v.search(/[/?#]/)
  if (cut >= 0) v = v.slice(0, cut)

  // A single trailing dot is the DNS root and is the same host.
  if (v.endsWith(".")) v = v.slice(0, -1)

  return v
}

/**
 * True when `host` is `entry` or a subdomain of it.
 *
 * The leading dot is what makes this correct: a bare `endsWith(entry)` would make
 * `notevil.com` match a `evil.com` entry, so an attacker who controls
 * `notevil.com` walks straight through a deny-list intended for `evil.com`.
 */
export function domainMatches(host: string, entry: string): boolean {
  const h = normalizeDomain(host)
  const e = normalizeDomain(entry)
  if (e.length === 0) return false
  if (h.length === 0) return false
  return h === e || h.endsWith("." + e)
}

/**
 * Pull candidate hostnames out of a shell command.
 *
 * This is a TEXT heuristic and its misses are the documented limitation above.
 * It is built to be conservative in one specific way: a host is reported only
 * when it looks like a hostname (has a dot, or is `localhost`), because a bare
 * word in a shell command is overwhelmingly a filename or an argument, and
 * reporting those as destinations would make the violation message nonsense.
 *
 * Schemes recognised are the ones that actually appear in fetch commands. A
 * scheme that is not recognised is still handled by the bare-host branch, so an
 * unknown scheme degrades to "the host is checked" rather than "no check".
 */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/([^\s'"`)]+)/gi

/**
 * Binaries whose arguments are scanned for bare hosts.
 *
 * This list exists because a bare dotted token is indistinguishable from a
 * filename: `README.md` is a syntactically valid hostname — `.md` is Moldova's
 * country code. Matching every dotted token therefore reports a destination for
 * `cat README.md`, and with an allow-list configured that turns ordinary file
 * work into a refusal ("readme.md is not in the allowed domain list").
 *
 * Scoping the scan to the arguments of binaries that actually open sockets fixes
 * that at the source and keeps the check useful where it matters. The residual
 * limitation is unchanged and already documented above: a destination assembled
 * at runtime still escapes a text scan.
 */
const NETWORK_BINARIES = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "ftp",
  "telnet",
  "git",
  "npm",
  "pnpm",
  "yarn",
  "pip",
  "pip3",
  "python",
  "python3",
  "node",
  "deno",
  "bun",
])

/** A dotted token, or `host:port`, appearing as an argument. */
const BARE_HOST_RE = /(?:\s|^)([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?::\d{1,5})?/gi

export function extractHosts(command: string): string[] {
  const found = new Set<string>()

  // Any explicit URL, wherever it appears.
  for (const m of command.matchAll(URL_RE)) {
    const host = normalizeDomain(m[1] ?? "")
    if (host.length > 0) found.add(host)
  }

  // Bare hosts, but only in the tail of a command that invokes something which
  // opens a socket.
  const tokens = command.split(/[\s;|&]+/).filter((t) => t.length > 0)
  const invokesNetworkBinary = tokens.some((t) => NETWORK_BINARIES.has(t.toLowerCase()))
  if (invokesNetworkBinary) {
    for (const m of command.matchAll(BARE_HOST_RE)) {
      const host = normalizeDomain(m[1] ?? "")
      if (host.length > 0) found.add(host)
    }
  }

  return [...found]
}

/**
 * Decide whether `command` violates `policy`.
 *
 * Returns the offending host when it does, so the caller can name it. Naming
 * the host is what makes the refusal actionable — "network blocked" tells the
 * model nothing it can correct; "evil.test is blocked by policy" does.
 */
export function networkViolationForCommand(command: string, policy: HostPolicy): string | undefined {
  if (policy.disableNetwork) return "network access is disabled for this session"

  const hosts = extractHosts(command)
  if (hosts.length === 0) return undefined

  // The route table, not a re-implementation of it. `proxy-routing.ts` owns the
  // decision — deny-before-allow ordering, "no rule matched" resolving to a
  // decision, and the address guard — and duplicating that logic here is how the
  // two copies drift apart with nothing to notice.
  //
  // The address guard is the part that could not live here alone: a domain
  // allow-list says nothing about `169.254.169.254`, which matches no entry and
  // was therefore reachable under a deny-list. That endpoint returns the cloud
  // identity of the machine the agent runs on.
  const table = routeTableFor({
    allowedDomains: policy.allowedDomains,
    blockedDomains: policy.blockedDomains,
    disableNetwork: false,
  })

  for (const host of hosts) {
    const decision = decideRoute(host, table)
    if (decision.allow) continue
    if (decision.addressVerdict !== undefined) return decision.reason
    // The table's own wording names the list; keep the phrasing callers already
    // parse for, so an existing refusal reads the way it always has.
    if (policy.blockedDomains.some((entry) => domainMatches(host, entry))) {
      return `${host} is blocked by policy`
    }
    return `${host} is not in the allowed domain list`
  }

  return undefined
}

/**
 * Tools that reach the network.
 *
 * `AGENTS.md` promises this flag exists and requires explicit approval outside
 * danger mode. It did not, so the promise is now a real, testable predicate
 * rather than a line in a handbook.
 *
 * Matching is on the tool NAME as declared, which is what the registry and the
 * permission ladder both key on. Substring matching is deliberate but the
 * prefixes are chosen so that `webfetchfoo` and `my_web_search_tool` do not
 * match by accident: the list is a capability declaration, and a capability
 * should not be granted to a tool that merely contains the word.
 */
const NETWORK_TOOL_NAMES: readonly string[] = [
  "nemo__WebFetch",
  "nemo__WebBrowse",
  "nemo__WebSearch",
  "nemo__WebSearchMulti",
  "nemo__WebSearchDeep",
  "nemo__Github",
  "nemo__Bash",
  "Bash",
  "web_fetch",
  "web_browse",
  "web_search",
]

export function isNetworkTool(toolName: string): boolean {
  if (NETWORK_TOOL_NAMES.includes(toolName)) return true
  return false
}

/** The tool names that reach the network, for display and for tests. */
export function networkToolNames(): readonly string[] {
  return NETWORK_TOOL_NAMES
}

/**
 * Resolve a `NetworkSandboxPolicy` from a loosely-typed permissions bag.
 *
 * The permission object reaches the tool layer as `unknown` and carries the
 * policy under `__networkPolicy`. Reading it defensively here rather than at
 * each call site is what keeps one caller from trusting a missing field as
 * `false` while another trusts it as `undefined`.
 *
 * IMPORTANT: nothing in production ever WROTE `__networkPolicy`. It was read by
 * `filterEnv` and by the bash tool's `networkDisabled` flag, and populated by
 * nothing — so a declared block-list could not reach this function even in
 * principle. The environment fallback below is what gives the field a producer.
 * A bag value still wins, because an explicit program-supplied policy is more
 * specific than ambient configuration.
 */
export function hostPolicyFromPermissions(perms: unknown): HostPolicy {
  return hostPolicyFromPermissionsWithEnv(perms)
}

/**
 * `hostPolicyFromPermissions` with an explicit environment.
 *
 * The injectable source exists so tests are deterministic: a developer with
 * `NEMO_BLOCKED_DOMAINS` exported in their shell would otherwise change
 * this module's results, which is the ambient-state dependency the repo's own
 * config-test rule forbids.
 */
export function hostPolicyFromPermissionsWithEnv(perms: unknown, source?: EnvSource): HostPolicy {
  const fromEnv = hostPolicyFromEnv(source)
  if (perms === null || typeof perms !== "object") return fromEnv
  const bag = perms as Record<string, unknown>
  const raw = bag.__networkPolicy
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fromEnv
  const policy = raw as Record<string, unknown>
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : []
  return {
    // Union rather than replace: a bag that sets only `disableNetwork` should not
    // silently discard host lists configured in the environment.
    allowedDomains: [...fromEnv.allowedDomains, ...strings(policy.allowedDomains)],
    blockedDomains: [...fromEnv.blockedDomains, ...strings(policy.blockedDomains)],
    disableNetwork: fromEnv.disableNetwork || policy.disableNetwork === true,
  }
}

/** Environment variables that carry the host policy. */
export const HOST_POLICY_ENV = {
  disable: "NEMO_NO_NETWORK",
  allowed: "NEMO_ALLOWED_DOMAINS",
  blocked: "NEMO_BLOCKED_DOMAINS",
} as const

/**
 * Build a host policy from the environment.
 *
 * This exists because the policy had no producer. `allowedDomains` and
 * `blockedDomains` were declared on `NetworkSandboxPolicy`, read in two places,
 * and set by nothing — so every real run produced the empty default and the
 * enforcement could never fire. Rather than widen the blast radius by editing
 * the shared config module, the surface is the environment, read through the
 * sanctioned `env_read` gateway so the repo's `no-direct-process-env` rule is
 * obeyed rather than bypassed.
 *
 * `NEMO_NO_NETWORK` accepts `1`/`true`/`yes`/`on`. Anything else, including
 * `0` and `false`, leaves it off — the repo convention is that an unrecognised
 * value falls back to the default rather than throwing.
 */
export function hostPolicyFromEnv(source?: EnvSource): HostPolicy {
  return {
    allowedDomains: envList(HOST_POLICY_ENV.allowed, source),
    blockedDomains: envList(HOST_POLICY_ENV.blocked, source),
    // /*fallback*/ — the second positional argument is the value used when the
    // variable is unset or unparseable. Named here because a bare `false` in
    // that position reads as "set the flag false" rather than "no default".
    disableNetwork: envBooleanStrict(HOST_POLICY_ENV.disable, /*fallback*/ false, source),
  }
}