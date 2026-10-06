/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import {
  applySecurityHeaders,
  buildSecurityTxt,
  checkRequestLimits,
  DEFAULT_SECURITY_CONTACT,
  MAX_HEADER_BYTES,
  MAX_URL_CHARS,
  SECURITY_HEADERS,
  SECURITY_TXT_PATH,
  securityContact,
} from "./security-headers.js"

function fakeRes(): { headers: Record<string, string>; setHeader(k: string, v: string): void } {
  const headers: Record<string, string> = {}
  return { headers, setHeader(k: string, v: string): void { headers[k] = v } }
}

describe("security headers", () => {
  it("covers clickjacking, sniffing, referrers, and sensors on every response", () => {
    const res = fakeRes()
    applySecurityHeaders(res as never)
    expect(res.headers["X-Frame-Options"]).toBe("DENY")
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff")
    expect(res.headers["Referrer-Policy"]).toBe("no-referrer")
    expect(res.headers["Permissions-Policy"]).toContain("camera=()")
    expect(res.headers["Permissions-Policy"]).toContain("microphone=()")
    expect(res.headers["Permissions-Policy"]).toContain("geolocation=()")
    // Framing denied outright (CSP + legacy header agree).
    expect(res.headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'")
    expect(Object.keys(res.headers)).toHaveLength(Object.keys(SECURITY_HEADERS).length)
  })
})

describe("request limits", () => {
  it("passes normal requests", () => {
    expect(checkRequestLimits({ url: "/health", rawHeaders: ["Host", "x"] })).toBeNull()
    expect(checkRequestLimits({})).toBeNull()
  })

  it("rejects oversized URLs with 414", () => {
    const verdict = checkRequestLimits({ url: `/${"a".repeat(MAX_URL_CHARS)}` })
    expect(verdict?.status).toBe(414)
    expect(checkRequestLimits({ url: `/${"a".repeat(MAX_URL_CHARS - 2)}` })).toBeNull()
  })

  it("rejects oversized header blocks with 431", () => {
    const big = "x".repeat(MAX_HEADER_BYTES + 1)
    expect(checkRequestLimits({ url: "/", rawHeaders: ["X-Big", big] })?.status).toBe(431)
    expect(checkRequestLimits({ url: "/", rawHeaders: ["X-Big", "x".repeat(100)] })).toBeNull()
  })
})

describe("security.txt", () => {
  it("serves from the well-known path with a real contact and expiry", () => {
    expect(SECURITY_TXT_PATH).toBe("/.well-known/security.txt")
    const body = buildSecurityTxt(DEFAULT_SECURITY_CONTACT, new Date("2026-10-04T00:00:00Z"))
    expect(body).toContain(`Contact: ${DEFAULT_SECURITY_CONTACT}`)
    expect(body).toContain("Expires: 2027-10-04")
  })

  it("contact is overridable without a rebuild", () => {
    expect(securityContact({})).toBe(DEFAULT_SECURITY_CONTACT)
    expect(securityContact({ TRAYAMBAK_SECURITY_CONTACT: "mailto:ops@example.com" })).toBe("mailto:ops@example.com")
    expect(securityContact({ TRAYAMBAK_SECURITY_CONTACT: "   " })).toBe(DEFAULT_SECURITY_CONTACT)
  })
})
