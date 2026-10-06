/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * HTTP hardening for the VPS-facing server (single choke point: the
 * `http.createServer` handler calls `applySecurityHeaders` + guards on
 * EVERY response, so nginx config can never silently strip them):
 *
 * - Clickjacking: `X-Frame-Options: DENY` + `frame-ancestors 'none'`.
 * - MIME sniffing: `X-Content-Type-Options: nosniff`.
 * - Referrer leaks: `Referrer-Policy: no-referrer`.
 * - Sensors: `Permissions-Policy` denies camera/mic/geolocation (+extras).
 * - CSP: strict enough to matter, loose enough to keep the first-party
 *   /admin page working (it ships inline `<script>`/`<style>` + inline
 *   handlers, so `script-src`/`style-src` keep `'unsafe-inline'`; the page
 *   is fully static with no reflected input, so XSS surface stays minimal
 *   and framing is denied outright).
 * - Request caps: URLs over MAX_URL_CHARS → 414, header blocks over
 *   MAX_HEADER_BYTES → 431 (the audit caught 8KB URLs/headers sailing
 *   through; Node's own 16KB ceiling is not a policy).
 * - `/.well-known/security.txt` (RFC 9116): vulnerability contact.
 */

import type * as http from "node:http"

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=()",
}

/** Apply to every response (success AND error paths). */
export function applySecurityHeaders(res: http.ServerResponse): void {
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(header, value)
  }
}

/** URLs longer than this are rejected with 414 (audit: 8KB sailed through). */
export const MAX_URL_CHARS = 2048
/** Total request-header bytes over this are rejected with 431. */
export const MAX_HEADER_BYTES = 8192

export interface RequestLimitVerdict {
  readonly status: 414 | 431
  readonly message: string
}

/** Null = within limits. Pure (takes url + raw headers, no socket). */
export function checkRequestLimits(req: { url?: string | null; rawHeaders?: string[] }): RequestLimitVerdict | null {
  const url = req.url ?? "/"
  if (url.length > MAX_URL_CHARS) {
    return { status: 414, message: `URL too long (max ${MAX_URL_CHARS} chars)` }
  }
  let headerBytes = 0
  for (const h of req.rawHeaders ?? []) headerBytes += Buffer.byteLength(h)
  if (headerBytes > MAX_HEADER_BYTES) {
    return { status: 431, message: `headers too large (max ${MAX_HEADER_BYTES} bytes)` }
  }
  return null
}

export const SECURITY_TXT_PATH = "/.well-known/security.txt"
export const SECURITY_TXT_CONTACT_ENV = "TRAYAMBAK_SECURITY_CONTACT"
export const DEFAULT_SECURITY_CONTACT = "mailto:support@sktailabs.in"

/** Contact override without a rebuild (VPS env). */
export function securityContact(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[SECURITY_TXT_CONTACT_ENV]?.trim()
  return raw ? raw : DEFAULT_SECURITY_CONTACT
}

/** RFC 9116 body: Contact (required) + Expires (rolling +365d). */
export function buildSecurityTxt(contact: string, now: Date = new Date()): string {
  const expires = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)
  return [`Contact: ${contact}`, `Expires: ${expires.toISOString()}`, ""].join("\n")
}
