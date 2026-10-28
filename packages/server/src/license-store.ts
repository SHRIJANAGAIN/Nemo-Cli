/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Server-side license registry — the actual lock.
 *
 * The CLI's shipped checksum can be extracted by anyone, so checksum-alone
 * verification is decoration. This registry makes forgery worthless: a key
 * is honored ONLY if its id sits in this store (written here at mint/import
 * time), isn't expired/revoked, and is activated on the requesting machine.
 * An attacker who extracts the check key can mint codes with valid
 * checksums all day — every one dies at "unknown license" below.
 *
 * Persistence: one JSON file (0600, atomic tmp+rename writes) for the key
 * registry. Sized for a license server (hundreds of keys), not a database.
 * Single Node process: no lock files, in-memory map flushed on every
 * mutation.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { normalizeLicenseKey, verifyLicenseKey, type LicensePlan } from "../../../apps/runtime/src/license.js"

export interface LicenseRecord {
  /** Key id from the code claims (hex). Registry primary key. */
  id: string
  /** Full display code (1102-XXXX-XXXX-XXXX). 0600 file, operator eyes only. */
  key: string
  plan: LicensePlan
  /** Expiry as unix seconds. */
  exp: number
  customer?: string
  revoked: boolean
  /** Self-service trial key (short-lived, 1 per machine). Shown in /admin. */
  trial?: boolean
  /** Machine UUID bound at activation. Absent = never activated. */
  boundMachineId?: string
  createdAt: string
  lastSeenAt?: string
}

export interface LicenseStorePaths {
  file: string
}

export function defaultLicenseStorePaths(): LicenseStorePaths {
  const file = process.env.LICENSE_STORE_PATH ?? "./data/licenses.json"
  return { file }
}

interface StoreFile {
  version: 1
  keys: Record<string, LicenseRecord>
}

function atomicWriteJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // Non-POSIX (win32 ACLs) — best effort.
  }
  renameSync(tmp, file)
}

function loadStoreFile(file: string): Record<string, LicenseRecord> {
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoreFile>
    if (parsed && typeof parsed === "object" && parsed.keys && typeof parsed.keys === "object") {
      return parsed.keys as Record<string, LicenseRecord>
    }
  } catch {
    // Torn write — start empty rather than crash the server. The .bak
    // discipline lives client-side; here availability wins and every mint
    // rewrites the file fresh.
  }
  return {}
}

export interface LicenseCheck {
  valid: boolean
  plan?: LicensePlan
  exp?: number
  reason?: string
  record?: LicenseRecord
}

/** Pure decision procedure, shared by /verify and /activate. */
export function checkLicense(
  keys: Record<string, LicenseRecord>,
  displayKey: string | undefined | null,
  machineId: string | undefined | null,
  secret?: string,
): LicenseCheck {
  const raw = typeof displayKey === "string" ? displayKey.trim() : ""
  if (!raw) return { valid: false, reason: "no license key supplied" }
  const compact = normalizeLicenseKey(raw)
  if (!compact) return { valid: false, reason: "malformed key (want 16 letters, 1102-XXXX-XXXX-XXXX)" }
  const v = verifyLicenseKey(raw, secret)
  if (v.valid !== true) return { valid: false, reason: v.valid === false ? v.reason : "invalid key" }
  const rec = keys[v.claims.id]
  // Full-code match: same id must mean the same code (kills id-collision
  // lookalikes across the two wire generations).
  if (!rec || normalizeLicenseKey(rec.key) !== compact) {
    return { valid: false, reason: "unknown license (not issued by Shrijan — register it via /admin first)" }
  }
  if (v.claims.exp * 1000 <= Date.now()) {
    return { valid: false, reason: `expired on ${new Date(v.claims.exp * 1000).toISOString().slice(0, 10)}` }
  }
  if (rec.revoked) return { valid: false, reason: "license revoked — contact Shrijan", record: rec }
  const machine = typeof machineId === "string" ? machineId.trim() : ""
  if (!machine) return { valid: false, reason: "no machine identity supplied", record: rec }
  if (!rec.boundMachineId) {
    return {
      valid: false,
      reason: "not activated on this machine — run /devmode on <key> once to bind it",
      record: rec,
    }
  }
  if (rec.boundMachineId !== machine) {
    return { valid: false, reason: "bound to another machine (1-machine license) — ask Shrijan to unbind it", record: rec }
  }
  return { valid: true, plan: v.claims.plan, exp: v.claims.exp, record: rec }
}

export class LicenseStore {
  private keys: Record<string, LicenseRecord>
  private readonly file: string
  private readonly secret?: string

  constructor(paths?: Partial<LicenseStorePaths>, secret?: string) {
    const defaults = defaultLicenseStorePaths()
    this.file = paths?.file ?? defaults.file
    this.secret = secret
    this.keys = loadStoreFile(this.file)
  }

  private save(): void {
    atomicWriteJson(this.file, { version: 1, keys: this.keys } satisfies StoreFile)
  }

  /** Register a freshly minted (or imported legacy) code. Idempotent on the
   *  full code — re-importing the same key returns the existing record. */
  register(displayKey: string, customer?: string, opts?: { trial?: boolean }): LicenseRecord {
    const v = verifyLicenseKey(displayKey, this.secret)
    if (v.valid !== true) {
      throw new Error(`cannot register: ${v.valid === false ? v.reason : "invalid key"}`)
    }
    const existing = this.keys[v.claims.id]
    const compact = normalizeLicenseKey(displayKey) as string // valid per verify above
    if (existing && normalizeLicenseKey(existing.key) === compact) return existing
    const rec: LicenseRecord = {
      id: v.claims.id,
      key: `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}`,
      plan: v.claims.plan,
      exp: v.claims.exp,
      customer: typeof customer === "string" && customer.trim() ? customer.trim().slice(0, 120) : undefined,
      revoked: false,
      trial: opts?.trial === true ? true : undefined,
      createdAt: new Date().toISOString(),
    }
    this.keys[rec.id] = rec
    this.save()
    return rec
  }

  check(displayKey: string | undefined | null, machineId: string | undefined | null): LicenseCheck {
    return checkLicense(this.keys, displayKey, machineId, this.secret)
  }

  /** Bind an unbound key to a machine. Same-machine re-activation is a
   *  no-op success; a different bound machine is a conflict (admin unbinds). */
  activate(
    displayKey: string | undefined | null,
    machineId: string | undefined | null,
  ): { ok: boolean; plan?: LicensePlan; exp?: number; reason?: string; record?: LicenseRecord } {
    const machine = typeof machineId === "string" ? machineId.trim() : ""
    if (!machine) return { ok: false, reason: "no machine identity supplied" }
    const c = this.check(displayKey, machine)
    if (c.valid === true) return { ok: true, plan: c.plan, exp: c.exp, record: c.record }
    // The only recoverable refusal is "never activated": bind now.
    if (c.record && !c.record.revoked && !c.record.boundMachineId && c.reason?.startsWith("not activated")) {
      c.record.boundMachineId = machine
      c.record.lastSeenAt = new Date().toISOString()
      this.save()
      return { ok: true, plan: c.record.plan, exp: c.record.exp, record: c.record }
    }
    return { ok: false, plan: c.plan, exp: c.exp, reason: c.reason, record: c.record }
  }

  revoke(idOrKey: string): boolean {
    const rec = this.find(idOrKey)
    if (!rec) return false
    rec.revoked = true
    this.save()
    return true
  }

  unbind(idOrKey: string): boolean {
    const rec = this.find(idOrKey)
    if (!rec) return false
    delete rec.boundMachineId
    this.save()
    return true
  }

  touch(id: string): void {
    const rec = this.keys[id]
    if (!rec) return
    rec.lastSeenAt = new Date().toISOString()
    this.save()
  }

  /** A live (unexpired, unrevoked) trial already bound to this machine, if
   *  any — the 1-trial-per-machine rule for self-service minting. */
  activeTrialForMachine(machineId: string): LicenseRecord | undefined {
    const now = Date.now()
    return Object.values(this.keys).find(
      (r) => r.trial === true && r.revoked !== true && r.exp * 1000 > now && r.boundMachineId === machineId,
    )
  }

  find(idOrKey: string): LicenseRecord | undefined {
    const t = idOrKey.trim()
    if (this.keys[t]) return this.keys[t]
    const compact = normalizeLicenseKey(t)
    if (!compact) return undefined
    return Object.values(this.keys).find((r) => normalizeLicenseKey(r.key) === compact)
  }

  list(): LicenseRecord[] {
    return Object.values(this.keys).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  get size(): number {
    return Object.keys(this.keys).length
  }
}
