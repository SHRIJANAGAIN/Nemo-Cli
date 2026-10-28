/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Pure policy tests for the web server's origin gate. No sockets, no server:
 * resolveCors() is a total function over (origin, host, allowlist), and the
 * security property under test is the refusal path — a foreign origin must be
 * refused server-side, because stripping CORS headers alone does not stop a
 * simple cross-origin POST from reaching the unauthenticated /license and
 * /auth/github routes.
 */

import { describe, expect, it } from "vitest"
import { parseCorsAllowlist, resolveCors } from "./cors.js"

const HOST = "127.0.0.1:8787"

describe("parseCorsAllowlist", () => {
  it("trims entries and drops blanks", () => {
    expect(parseCorsAllowlist(" http://a.dev , ,https://b.dev ")).toEqual(["http://a.dev", "https://b.dev"])
  })

  it("treats missing input as an empty allowlist (same-origin + loopback only)", () => {
    expect(parseCorsAllowlist(undefined)).toEqual([])
    expect(parseCorsAllowlist("")).toEqual([])
  })
})

describe("resolveCors — non-browser clients", () => {
  it("emits no CORS headers when there is no Origin, and refuses nothing", () => {
    const decision = resolveCors(undefined, HOST, "")
    expect(decision.headers).toEqual({})
    expect(decision.allowed).toBe(true)
  })

  it("treats an empty Origin header like a missing one", () => {
    expect(resolveCors("", HOST, "").allowed).toBe(true)
  })
})

describe("resolveCors — allowed origins", () => {
  it("echoes a same-origin browser request", () => {
    const decision = resolveCors(`http://${HOST}`, HOST, "")
    expect(decision.allowed).toBe(true)
    expect(decision.headers["Access-Control-Allow-Origin"]).toBe(`http://${HOST}`)
    expect(decision.headers["Access-Control-Allow-Headers"]).toBe("Content-Type, Authorization")
    expect(decision.headers.Vary).toBe("Origin")
  })

  it("allows any loopback port, not just the API's own port", () => {
    // Deliberate: a loopback origin is same-machine (local dev servers,
    // another nemo instance). The web-origin model calls a different
    // port cross-origin, and it is — we allow it on loopback only.
    expect(resolveCors("http://127.0.0.1:3000", HOST, "").allowed).toBe(true)
  })

  it("refuses a different-port origin on a NON-loopback host (same host, not same origin)", () => {
    expect(resolveCors("http://console.nemo.dev:3000", "console.nemo.dev:8787", "").allowed).toBe(false)
  })

  it("allows loopback origins so a local dev server keeps working", () => {
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173", "https://localhost", "http://[::1]:8787"]) {
      const decision = resolveCors(origin, HOST, "")
      expect(decision.allowed).toBe(true)
      expect(decision.headers["Access-Control-Allow-Origin"]).toBe(origin)
    }
  })

  it("allows an explicitly listed origin (exact match, not prefix)", () => {
    expect(resolveCors("https://console.nemo.dev", HOST, "https://console.nemo.dev").allowed).toBe(true)
    // A near-miss (subdomain or extra path) is NOT covered by the entry.
    expect(resolveCors("https://evil.console.nemo.dev", HOST, "https://console.nemo.dev").allowed).toBe(false)
    expect(resolveCors("https://console.nemo.dev/evil", HOST, "https://console.nemo.dev").allowed).toBe(false)
  })

  it("restores the wildcard only when explicitly asked for", () => {
    const decision = resolveCors("https://anywhere.example", HOST, "*")
    expect(decision.allowed).toBe(true)
    expect(decision.headers["Access-Control-Allow-Origin"]).toBe("*")
  })
})

describe("resolveCors — refused origins", () => {
  it("refuses a foreign web origin", () => {
    const decision = resolveCors("https://phishing.example", HOST, "")
    expect(decision.allowed).toBe(false)
    expect(decision.headers).toEqual({})
  })

  it("refuses non-http schemes even when they claim a loopback host", () => {
    // file:// and extension schemes carry no origin protection worth trusting.
    for (const origin of ["file://localhost", "chrome-extension://abcdef", "null"]) {
      const decision = resolveCors(origin, HOST, "")
      expect(decision.allowed).toBe(false)
      expect(decision.headers).toEqual({})
    }
  })

  it("refuses a malformed Origin instead of guessing", () => {
    expect(resolveCors("http://", HOST, "").allowed).toBe(false)
  })

  it("refuses a non-loopback origin when the Host header is missing (nothing to anchor on)", () => {
    expect(resolveCors("http://console.nemo.dev", undefined, "").allowed).toBe(false)
    // Loopback needs no anchor, so it still passes without a Host header.
    expect(resolveCors("http://127.0.0.1:8787", undefined, "").allowed).toBe(true)
  })

  it("never emits an allow-origin header together with a refusal", () => {
    const decision = resolveCors("https://phishing.example", HOST, "https://other.example")
    expect(decision.allowed).toBe(false)
    expect(decision.headers["Access-Control-Allow-Origin"]).toBeUndefined()
  })
})
