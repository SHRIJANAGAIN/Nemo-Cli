/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { mintActivationKey, mintLegacyActivationKey } from "../../../apps/runtime/src/license.js"
import { LicenseStore } from "./license-store.js"

// Throwaway secret — the point is registry membership, not the checksum.
const SECRET = "store-test-secret-0000000000000000"

afterEach(() => {
  vi.unstubAllEnvs()
})

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), "lic-store-"))
  return new LicenseStore({ file: join(dir, "licenses.json"), usageFile: join(dir, "usage.jsonl") }, SECRET)
}

function expDaysFromToday(days: number): number {
  return Math.floor(Date.now() / 86400000) - Math.floor(Date.UTC(2026, 0, 1) / 86400000) + days
}

describe("LicenseStore", () => {
  it("registers minted keys and persists them across instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "lic-persist-"))
    const paths = { file: join(dir, "licenses.json"), usageFile: join(dir, "usage.jsonl") }
    const a = new LicenseStore(paths, SECRET)
    const key = mintActivationKey({ plan: "pentest", expDays: expDaysFromToday(30) }, SECRET)
    const rec = a.register(key, "acme")
    expect(rec.plan).toBe("pentest")
    expect(rec.customer).toBe("acme")
    expect(rec.boundMachineId).toBeUndefined()
    const b = new LicenseStore(paths, SECRET)
    expect(b.size).toBe(1)
    // Unactivated key: known but not usable anywhere yet.
    expect(b.check(key, "machine-1").valid).toBe(false)
  })

  it("runs the full lifecycle: activate -> verify -> conflict -> unbind -> revoke", () => {
    const s = tmpStore()
    const key = mintActivationKey({ plan: "pentest", expDays: expDaysFromToday(30) }, SECRET)
    s.register(key)
    const first = s.activate(key, "machine-1")
    expect(first.ok).toBe(true)
    expect(s.check(key, "machine-1").valid).toBe(true)
    // Same machine re-activation is idempotent.
    expect(s.activate(key, "machine-1").ok).toBe(true)
    // Second machine conflicts (1-machine license).
    const clash = s.activate(key, "machine-2")
    expect(clash.ok).toBe(false)
    expect(clash.reason ?? "").toContain("another machine")
    expect(s.check(key, "machine-2").valid).toBe(false)
    // Admin unbind frees the key for the new machine.
    expect(s.unbind(key)).toBe(true)
    expect(s.activate(key, "machine-2").ok).toBe(true)
    expect(s.check(key, "machine-2").valid).toBe(true)
    // Revocation kills it everywhere.
    expect(s.revoke(key)).toBe(true)
    expect(s.check(key, "machine-2").valid).toBe(false)
    expect(s.activate(key, "machine-3").ok).toBe(false)
  })

  it("rejects forged keys: valid checksum, unknown registry id", () => {
    const s = tmpStore()
    // Attacker extracts the check key and mints — checksum verifies fine.
    const forged = mintActivationKey({ plan: "pentest", expDays: expDaysFromToday(30) }, SECRET)
    const c = s.check(forged, "machine-1")
    expect(c.valid).toBe(false)
    expect(c.reason ?? "").toContain("not issued")
    expect(s.activate(forged, "machine-1").ok).toBe(false)
  })

  it("rejects expired, revoked-unknown, malformed, and basic-plan pentest", () => {
    const s = tmpStore()
    // Expired codes die at the checksum/expiry step — before the registry
    // is even consulted (nothing worth registering).
    const expired = mintActivationKey({ plan: "pentest", expDays: 1 }, SECRET)
    expect(s.check(expired, "m").valid).toBe(false)
    expect(s.activate(expired, "m").ok).toBe(false)
    expect(s.check("garbage!!", "m").valid).toBe(false)
    expect(s.check(undefined, "m").valid).toBe(false)
    const basic = mintActivationKey({ plan: "basic", expDays: expDaysFromToday(30) }, SECRET)
    s.register(basic)
    expect(s.activate(basic, "m").ok).toBe(true) // activation is plan-agnostic
    const pentest = s.checkPentestOnly(basic, "m")
    expect(pentest.valid).toBe(false)
    expect(pentest.reason ?? "").toContain("does not cover pentest")
  })

  it("accepts legacy pre-prefix codes via import (re-activation path)", () => {
    // A legacy-generation code (ver=1, 80-bit wire format — the shape minted
    // before the 1102 brand prefix): minted fresh here so the test never
    // rots on a hardcoded expiry. The verifier still reads it via fallback.
    const dir = mkdtempSync(join(tmpdir(), "lic-leg-"))
    const mine = new LicenseStore({ file: join(dir, "l.json"), usageFile: join(dir, "u.jsonl") }, SECRET)
    const legacy = mintLegacyActivationKey({ plan: "pentest", expDays: expDaysFromToday(365) }, SECRET)
    const rec = mine.register(legacy, "legacy-corp")
    expect(rec.plan).toBe("pentest")
    expect(mine.activate(legacy, "m1").ok).toBe(true)
    expect(mine.check(legacy, "m1").valid).toBe(true)
    const other = tmpStore()
    expect(other.check(legacy, "m1").valid).toBe(false) // other registry, unknown
  })

  it("appends usage telemetry and tails it", () => {
    const s = tmpStore()
    const key = mintActivationKey({ plan: "pentest", expDays: expDaysFromToday(30) }, SECRET)
    const rec = s.register(key)
    s.appendUsage({
      keyId: rec.id,
      machineId: "m1",
      tool: "trayambak__PentestRunTool",
      target: "example.com",
      ok: true,
    })
    s.appendUsage({ keyId: rec.id, machineId: "m1", tool: "trayambak__PentestPortScan", target: "", ok: false })
    const tail = s.readUsageTail(10)
    expect(tail).toHaveLength(2)
    expect(tail[0]?.tool).toBe("trayambak__PentestRunTool")
    expect(tail[0]?.target).toBe("example.com")
    expect(typeof tail[0]?.ts).toBe("string")
  })

  it("refuses to register garbage", () => {
    const s = tmpStore()
    expect(() => s.register("not-a-key")).toThrow()
    expect(s.revoke("nope")).toBe(false)
    expect(s.unbind("nope")).toBe(false)
  })
})
