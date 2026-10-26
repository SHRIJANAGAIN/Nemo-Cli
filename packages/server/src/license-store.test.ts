/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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
  return new LicenseStore({ file: join(dir, "licenses.json") }, SECRET)
}

function expDaysFromToday(days: number): number {
  return Math.floor(Date.now() / 86400000) - Math.floor(Date.UTC(2026, 0, 1) / 86400000) + days
}

describe("LicenseStore", () => {
  it("registers minted keys and persists them across instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "lic-persist-"))
    const paths = { file: join(dir, "licenses.json") }
    const a = new LicenseStore(paths, SECRET)
    const key = mintActivationKey({ plan: "pro", expDays: expDaysFromToday(30) }, SECRET)
    const rec = a.register(key, "acme")
    expect(rec.plan).toBe("pro")
    expect(rec.customer).toBe("acme")
    expect(rec.boundMachineId).toBeUndefined()
    const b = new LicenseStore(paths, SECRET)
    expect(b.size).toBe(1)
    // Unactivated key: known but not usable anywhere yet.
    expect(b.check(key, "machine-1").valid).toBe(false)
  })

  it("runs the full lifecycle: activate -> verify -> conflict -> unbind -> revoke", () => {
    const s = tmpStore()
    const key = mintActivationKey({ plan: "pro", expDays: expDaysFromToday(30) }, SECRET)
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
    const forged = mintActivationKey({ plan: "pro", expDays: expDaysFromToday(30) }, SECRET)
    const c = s.check(forged, "machine-1")
    expect(c.valid).toBe(false)
    expect(c.reason ?? "").toContain("not issued")
    expect(s.activate(forged, "machine-1").ok).toBe(false)
  })

  it("rejects expired, revoked-unknown, and malformed codes", () => {
    const s = tmpStore()
    // Expired codes die at the checksum/expiry step — before the registry
    // is even consulted (nothing worth registering).
    const expired = mintActivationKey({ plan: "pro", expDays: 1 }, SECRET)
    expect(s.check(expired, "m").valid).toBe(false)
    expect(s.activate(expired, "m").ok).toBe(false)
    expect(s.check("garbage!!", "m").valid).toBe(false)
    expect(s.check(undefined, "m").valid).toBe(false)
    const basic = mintActivationKey({ plan: "basic", expDays: expDaysFromToday(30) }, SECRET)
    s.register(basic)
    expect(s.activate(basic, "m").ok).toBe(true) // activation is plan-agnostic
    expect(s.check(basic, "m").valid).toBe(true)
  })

  it("accepts legacy pre-prefix codes via import (re-activation path)", () => {
    // A legacy-generation code (ver=1, 80-bit wire format — the shape minted
    // before the 1102 brand prefix): minted fresh here so the test never
    // rots on a hardcoded expiry. The verifier still reads it via fallback.
    const dir = mkdtempSync(join(tmpdir(), "lic-leg-"))
    const mine = new LicenseStore({ file: join(dir, "l.json") }, SECRET)
    const legacy = mintLegacyActivationKey({ plan: "pro", expDays: expDaysFromToday(365) }, SECRET)
    const rec = mine.register(legacy, "legacy-corp")
    expect(rec.plan).toBe("pro")
    expect(mine.activate(legacy, "m1").ok).toBe(true)
    expect(mine.check(legacy, "m1").valid).toBe(true)
    const other = tmpStore()
    expect(other.check(legacy, "m1").valid).toBe(false) // other registry, unknown
  })

  it("refuses to register garbage", () => {
    const s = tmpStore()
    expect(() => s.register("not-a-key")).toThrow()
    expect(s.revoke("nope")).toBe(false)
    expect(s.unbind("nope")).toBe(false)
  })
})
