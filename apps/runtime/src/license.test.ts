/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it, afterEach, vi } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  canUnlockDevmode,
  canUsePentest,
  getMachineId,
  mintActivationKey,
  mintLegacyActivationKey,
  normalizeLicenseKey,
  reportToolUsage,
  serverActivateLicenseKey,
  serverCanUsePentest,
  serverMintTrial,
  serverVerifyLicenseKey,
  verifyLicenseKey,
} from "./license.js"

// Throwaway minting secret for tests — NEVER the shipped check key.
// (The shipped key lives in license.ts; tests must not depend on it.)
const TEST_SECRET = "test-only-activation-check-secret-000"

const expDays = (): number => {
  const today = Math.floor(Date.now() / 86400000)
  const epoch = Math.floor(Date.UTC(2026, 0, 1) / 86400000)
  return today - epoch + 365
}

describe("normalizeLicenseKey", () => {
  it("accepts dashed/lowercase/spaced input, rejects the rest", () => {
    const key = mintActivationKey({ plan: "pentest", expDays: expDays() }, TEST_SECRET)
    expect(key).toMatch(/^1102-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    expect(normalizeLicenseKey(key.toLowerCase().replace(/-/g, " "))).toBe(key.replace(/-/g, ""))
    expect(normalizeLicenseKey("short")).toBeNull()
    // Punctuation strips out — shape check only; validity is verify's job.
    expect(normalizeLicenseKey("XXXX-XXXX-XXXX-XXXX!")).toBe("XXXXXXXXXXXXXXXX")
    expect(normalizeLicenseKey("IIII-IIII-IIII-IIII")).toBeNull() // I not in alphabet
    expect(normalizeLicenseKey(undefined)).toBeNull()
    expect(normalizeLicenseKey("")).toBeNull()
  })
})

describe("verifyLicenseKey", () => {
  it("accepts a well-formed minted key with intact claims", () => {
    const key = mintActivationKey({ plan: "pentest", expDays: expDays() }, TEST_SECRET)
    const v = verifyLicenseKey(key, TEST_SECRET)
    expect(v.valid).toBe(true)
    if (v.valid) {
      expect(v.claims.plan).toBe("pentest")
      expect(v.claims.id).toMatch(/^[0-9a-f]+$/)
      expect(v.claims.exp * 1000).toBeGreaterThan(Date.now())
    }
  })

  it("reads legacy-generation (ver=1) codes via fallback", () => {
    const key = mintLegacyActivationKey({ plan: "pro", expDays: expDays() }, TEST_SECRET)
    expect(key).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    const v = verifyLicenseKey(key, TEST_SECRET)
    expect(v.valid).toBe(true)
    if (v.valid) expect(v.claims.plan).toBe("pro")
  })

  it("rejects single-char tampering anywhere in the code", () => {
    const key = mintActivationKey({ plan: "pentest", expDays: expDays() }, TEST_SECRET).replace(/-/g, "")
    for (const pos of [0, 5, 10, 15]) {
      const tampered = key.slice(0, pos) + (key[pos] === "A" ? "B" : "A") + key.slice(pos + 1)
      expect(verifyLicenseKey(tampered, TEST_SECRET).valid, `pos ${pos}`).toBe(false)
    }
  })

  it("rejects keys minted under a different secret", () => {
    const key = mintActivationKey({ plan: "pentest", expDays: expDays() }, "some-other-secret-0000000000000")
    expect(verifyLicenseKey(key, TEST_SECRET).valid).toBe(false)
  })

  it("rejects expired keys", () => {
    const key = mintActivationKey({ plan: "pentest", expDays: 1 }, TEST_SECRET)
    const v = verifyLicenseKey(key, TEST_SECRET)
    expect(v.valid).toBe(false)
    if (!v.valid) expect(v.reason).toContain("expired")
  })

  it("rejects garbage with reasons, never throws", () => {
    for (const bad of [undefined, "", "short", "XXXX-XXXX-XXXX-XXXX", "0000-0000-0000-0000"]) {
      const v = verifyLicenseKey(bad, TEST_SECRET)
      expect(v.valid).toBe(false)
      if (!v.valid) expect(typeof v.reason).toBe("string")
    }
  })

  it("every minted key starts with the 1102 brand prefix", () => {
    for (const plan of ["basic", "pentest", "pro", "enterprise"] as const) {
      const key = mintActivationKey({ plan, expDays: expDays() }, TEST_SECRET)
      expect(key.startsWith("1102-")).toBe(true)
      expect(verifyLicenseKey(key, TEST_SECRET).valid).toBe(true)
    }
  })

  it("minted random parts differ key to key (no sequential pattern)", () => {
    const keys = new Set(
      Array.from({ length: 10 }, () => mintActivationKey({ plan: "pentest", expDays: expDays() }, TEST_SECRET)),
    )
    expect(keys.size).toBe(10)
  })
})

describe("canUsePentest", () => {
  it("allows pentest/pro/enterprise plans, blocks basic + invalid", () => {
    for (const plan of ["pentest", "pro", "enterprise"] as const) {
      expect(canUsePentest(mintActivationKey({ plan, expDays: expDays() }, TEST_SECRET), TEST_SECRET)).toBe(true)
    }
    expect(canUsePentest(mintActivationKey({ plan: "basic", expDays: expDays() }, TEST_SECRET), TEST_SECRET)).toBe(
      false,
    )
    expect(canUsePentest(undefined)).toBe(false)
  })
})

describe("canUnlockDevmode", () => {
  it("devmode unlocks with the license itself (any valid plan)", () => {
    const key = mintActivationKey({ plan: "basic", expDays: expDays() }, TEST_SECRET)
    expect(canUnlockDevmode(key, TEST_SECRET).valid).toBe(true)
    expect(canUnlockDevmode("bogus", TEST_SECRET).valid).toBe(false)
    expect(canUnlockDevmode(undefined, TEST_SECRET).valid).toBe(false)
  })
})

describe("machine identity", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("mints a stable UUID in the override file, never touching the real home", () => {
    const file = join(mkdtempSync(join(tmpdir(), "lic-mid-")), "machine-id")
    vi.stubEnv("TRAYAMBAK_MACHINE_ID_FILE", file)
    const first = getMachineId()
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(getMachineId()).toBe(first)
  })
})

describe("server licensing client", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  async function stub(routes: Record<string, (body: Record<string, unknown>) => { status: number; json: unknown }>) {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = []
    const server = createServer((req, res) => {
      let data = ""
      req.on("data", (c) => {
        data += c.toString()
      })
      req.on("end", () => {
        const handler = routes[req.url ?? ""]
        if (!handler) {
          res.writeHead(404, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "not found" }))
          return
        }
        const body = JSON.parse(data) as Record<string, unknown>
        seen.push({ url: req.url ?? "", body })
        const { status, json } = handler(body)
        res.writeHead(status, { "Content-Type": "application/json" })
        res.end(JSON.stringify(json))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return {
      url,
      seen,
      close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    }
  }

  it("verifies, activates, and reports usage against a live server", async () => {
    const s = await stub({
      "/license/verify": () => ({ status: 200, json: { valid: true, plan: "pentest", exp: 1893456000 } }),
      "/license/activate": () => ({ status: 200, json: { ok: true, plan: "pentest", exp: 1893456000 } }),
      "/license/usage": () => ({ status: 200, json: { ok: true } }),
    })
    try {
      const key = "1102-AAAA-BBBB-CCCC"
      const v = await serverVerifyLicenseKey(key, { serverUrl: s.url, machineId: "m1" })
      expect(v).toMatchObject({ valid: true, plan: "pentest" })
      const p = await serverCanUsePentest(key, { serverUrl: s.url, machineId: "m1" })
      expect(p.valid).toBe(true)
      const a = await serverActivateLicenseKey(key, { serverUrl: s.url, machineId: "m1" })
      expect(a.ok).toBe(true)
      expect(
        await reportToolUsage(
          key,
          { tool: "trayambak__PentestRunTool", target: "example.com" },
          { serverUrl: s.url, machineId: "m1" },
        ),
      ).toBe(true)
      expect(s.seen.map((r) => r.url)).toEqual([
        "/license/verify",
        "/license/verify",
        "/license/activate",
        "/license/usage",
      ])
      expect(s.seen[3]?.body).toMatchObject({ tool: "trayambak__PentestRunTool", target: "example.com" })
    } finally {
      await s.close()
    }
  })

  it("surfaces server refusals and fails closed without a network", async () => {
    const s = await stub({
      "/license/verify": () => ({ status: 200, json: { valid: false, reason: "bound to another machine" } }),
      "/license/activate": () => ({ status: 200, json: { ok: false, reason: "bound to another machine" } }),
      "/license/usage": () => ({ status: 403, json: { error: "license invalid" } }),
    })
    try {
      const key = "1102-AAAA-BBBB-CCCC"
      const v = await serverVerifyLicenseKey(key, { serverUrl: s.url, machineId: "m1" })
      expect(v.valid).toBe(false)
      expect(v.reason).toContain("another machine")
      const basic = await stub({
        "/license/verify": () => ({ status: 200, json: { valid: true, plan: "basic", exp: 1893456000 } }),
      })
      try {
        const p = await serverCanUsePentest(key, { serverUrl: basic.url, machineId: "m1" })
        expect(p.valid).toBe(false)
        expect(p.reason).toContain("does not cover pentest")
      } finally {
        await basic.close()
      }
      const a = await serverActivateLicenseKey(key, { serverUrl: s.url, machineId: "m1" })
      expect(a.ok).toBe(false)
      expect(await reportToolUsage(key, { tool: "x" }, { serverUrl: s.url, machineId: "m1" })).toBe(false)
      // No server at all: unreachable, never valid, never throws.
      const dead = await serverVerifyLicenseKey(key, {
        serverUrl: "http://127.0.0.1:1",
        machineId: "m1",
        timeoutMs: 2000,
      })
      expect(dead.valid).toBe(false)
      expect(dead.reason).toContain("unreachable")
      const deadAct = await serverActivateLicenseKey(key, {
        serverUrl: "http://127.0.0.1:1",
        machineId: "m1",
        timeoutMs: 2000,
      })
      expect(deadAct.ok).toBe(false)
      expect(
        await reportToolUsage(
          key,
          { tool: "x" },
          { serverUrl: "http://127.0.0.1:1", machineId: "m1", timeoutMs: 2000 },
        ),
      ).toBe(false)
    } finally {
      await s.close()
    }
  })

  it("rejects malformed keys locally without touching the network", async () => {
    const v = await serverVerifyLicenseKey("bogus", {
      serverUrl: "http://127.0.0.1:1",
      machineId: "m1",
      timeoutMs: 1000,
    })
    expect(v.valid).toBe(false)
    expect(v.reason).toContain("malformed")
    const a = await serverActivateLicenseKey("", { serverUrl: "http://127.0.0.1:1", machineId: "m1", timeoutMs: 1000 })
    expect(a.ok).toBe(false)
  })

  it("mints self-service trials and surfaces trial refusals", async () => {
    const s = await stub({
      "/license/mint-trial": (body) =>
        body.machineId === "trial-machine-1"
          ? { status: 200, json: { ok: true, key: "1102-AAAA-BBBB-CCCC", id: "abcd", exp: 1893456000, days: 7 } }
          : { status: 409, json: { ok: false, reason: "this machine already has a live trial" } },
    })
    try {
      const ok = await serverMintTrial({ serverUrl: s.url, machineId: "trial-machine-1" })
      expect(ok).toMatchObject({ ok: true, key: "1102-AAAA-BBBB-CCCC", days: 7 })
      const clash = await serverMintTrial({ serverUrl: s.url, machineId: "trial-machine-2" })
      expect(clash.ok).toBe(false)
      expect(clash.reason).toContain("live trial")
      const dead = await serverMintTrial({
        serverUrl: "http://127.0.0.1:1",
        machineId: "trial-machine-9",
        timeoutMs: 2000,
      })
      expect(dead.ok).toBe(false)
      expect(dead.reason).toContain("unreachable")
    } finally {
      await s.close()
    }
  })
})
