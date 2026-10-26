/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * CORS policy for the local web server.
 *
 * The page the server hosts is same-origin, so it needs no CORS at all. CORS
 * matters here for what it REFUSES: several endpoints below the auth gate are
 * unauthenticated by design (/license/*, /auth/github/*, /github/read), so a
 * wildcard let any website a user visited call them from that page — mint a
 * trial, kick off a GitHub OAuth flow, read local state.
 *
 * Decision order:
 *   1. No Origin header (curl, node client, the CLI itself) → not a browser
 *      cross-origin request: no CORS headers emitted, nothing refused.
 *   2. Allowlist contains "*" (explicit NEMO_WEB_ORIGINS=*) → wildcard,
 *      the pre-hardening behavior, now opt-in only.
 *   3. Same-origin (origin host:port === the request's Host header) → echo.
 *   4. Loopback origin (localhost / 127.0.0.1 / [::1] over http/https) → echo,
 *      so a local dev server or a second nemo instance still works.
 *   5. Exact match in the comma-separated allowlist → echo.
 *   6. Otherwise REFUSED: no CORS headers and `allowed: false`, so the caller
 *      can reject the request server-side. That last part is load-bearing —
 *      CORS headers alone do not stop a *simple* cross-origin POST (no
 *      preflight, e.g. Content-Type: text/plain) from reaching an
 *      unauthenticated endpoint; refusing in the handler does.
 */

export interface CorsDecision {
  /** Headers to set on the response (empty when there is nothing to allow). */
  readonly headers: Record<string, string>
  /** False only when a browser Origin was explicitly refused. */
  readonly allowed: boolean
}

const ALLOW_HEADERS = "Content-Type, Authorization"

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "")
  return h === "localhost" || h === "127.0.0.1" || h === "::1"
}

/** Split a comma-separated allowlist, trimming blanks. "*" is kept verbatim. */
export function parseCorsAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * Decide the CORS outcome for one request.
 *
 * @param origin        the request's Origin header (undefined for non-browser clients)
 * @param host          the request's Host header — same-origin comparison anchor
 * @param allowlistRaw  NEMO_WEB_ORIGINS, comma-separated; "*" re-allows everything
 */
export function resolveCors(
  origin: string | undefined,
  host: string | undefined,
  allowlistRaw: string | undefined,
): CorsDecision {
  const allowlist = parseCorsAllowlist(allowlistRaw)
  if (allowlist.includes("*")) {
    return {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": ALLOW_HEADERS,
      },
      allowed: true,
    }
  }
  if (origin === undefined || origin === "") {
    return { headers: {}, allowed: true }
  }

  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    // A malformed Origin is not a browser we can reason about → refuse.
    return { headers: {}, allowed: false }
  }

  const sameOrigin = host !== undefined && host !== "" && parsed.host === host
  const loopback = (parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopbackHostname(parsed.hostname)
  const listed = allowlist.includes(origin)
  if (!sameOrigin && !loopback && !listed) return { headers: {}, allowed: false }

  return {
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": ALLOW_HEADERS,
      // The verdict depends on Origin, so caches must never reuse one.
      Vary: "Origin",
    },
    allowed: true,
  }
}
