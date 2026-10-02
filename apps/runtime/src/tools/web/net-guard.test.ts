/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import * as dns from "node:dns"
import { guardedLookup, isBlockedAddress, urlBlockReason } from "./net-guard.js"

type LookupOutcome = {
  err: NodeJS.ErrnoException | null
  address: string | dns.LookupAddress[] | undefined
  family?: number
}

function lookupAsync(hostname: string, options: dns.LookupOptions = {}): Promise<LookupOutcome> {
  return new Promise((resolve) => {
    guardedLookup(hostname, options, (err, address, family) => resolve({ err, address, family }))
  })
}

describe("isBlockedAddress", () => {
  it("blocks the IPv4 link-local range (cloud IMDS lives there)", () => {
    expect(isBlockedAddress("169.254.169.254")).toBe(true)
    expect(isBlockedAddress("169.254.0.1")).toBe(true)
    expect(isBlockedAddress("169.255.0.1")).toBe(false)
  })

  it("keeps loopback and private ranges allowed (local dev-server use)", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(false)
    expect(isBlockedAddress("10.0.0.7")).toBe(false)
    expect(isBlockedAddress("192.168.1.4")).toBe(false)
    expect(isBlockedAddress("8.8.8.8")).toBe(false)
  })

  it("blocks IPv6 link-local, bracketed, and IPv4-mapped forms", () => {
    expect(isBlockedAddress("fe80::1")).toBe(true)
    expect(isBlockedAddress("fe90::1")).toBe(true)
    expect(isBlockedAddress("febf::dead:beef")).toBe(true)
    expect(isBlockedAddress("[fe80::1]")).toBe(true)
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true)
    expect(isBlockedAddress("2001:db8::1")).toBe(false)
    expect(isBlockedAddress("::1")).toBe(false)
    expect(isBlockedAddress("fc00::1")).toBe(false)
  })
})

describe("urlBlockReason", () => {
  it("allows normal http/https URLs including loopback", () => {
    expect(urlBlockReason(new URL("https://example.com/docs"))).toBeNull()
    expect(urlBlockReason(new URL("http://127.0.0.1:3000/api"))).toBeNull()
    expect(urlBlockReason(new URL("http://localhost:8000"))).toBeNull()
  })

  it("blocks link-local literals (#73)", () => {
    expect(urlBlockReason(new URL("http://169.254.169.254/latest/meta-data/"))).toContain("link-local")
    expect(urlBlockReason(new URL("https://169.254.169.254/"))).toContain("link-local")
    expect(urlBlockReason(new URL("http://[fe80::1]/"))).toContain("link-local")
  })

  it("blocks non-http protocols on redirect hops", () => {
    expect(urlBlockReason(new URL("file:///etc/passwd"))).toContain("unsupported protocol")
    expect(urlBlockReason(new URL("ftp://files.example/x"))).toContain("unsupported protocol")
    expect(urlBlockReason(new URL("httpfoo://weird.example/"))).toContain("unsupported protocol")
  })
})

describe("guardedLookup", () => {
  // Literal IPs short-circuit inside dns.lookup — no resolver, no network.
  it("refuses a link-local literal before connecting (#73)", async () => {
    const { err, address } = await lookupAsync("169.254.169.254")
    expect(err).not.toBeNull()
    expect(err?.code).toBe("EACCES")
    expect(String(err?.message)).toContain("link-local")
    expect(address).toBe("")
  })

  it("refuses the all:true array form when any address is link-local", async () => {
    const { err } = await lookupAsync("169.254.169.254", { all: true })
    expect(err).not.toBeNull()
    expect(err?.code).toBe("EACCES")
  })

  it("passes loopback through untouched", async () => {
    const { err, address } = await lookupAsync("127.0.0.1")
    expect(err).toBeNull()
    expect(String(address)).toBe("127.0.0.1")
  })

  it("resolves allowed addresses with real dns.lookup behavior intact", async () => {
    const { err, address } = await lookupAsync("localhost")
    expect(err).toBeNull()
    expect(address === undefined || address === "").toBe(false)
  })
})
