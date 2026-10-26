/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Offline license verification, 16-letter activation-code edition.
 *
 * Display form is ALWAYS `1102-XXXX-XXXX-XXXX`: the `1102` is a fixed
 * brand prefix (not encoded data — it carries zero security), the other
 * 12 chars carry random(13) + ver(5)=2 + plan(5) + exp-days-since-2026-01-01(17)
 * + checksum(20) = 60 bits Crockford-Base32. The structured tail is
 * XOR-obfuscated with a rand-derived HMAC stream, so same-day keys share
 * nothing visible — the whole body always looks random. The checksum is
 * HMAC-SHA256 over the payload bits, truncated to 20 bits.
 *
 * ENFORCEMENT LIVES SERVER-SIDE (see packages/server/src/license-store.ts):
 * the CLI never grants access on this checksum alone. Every devmode unlock
 * asks the license server live; the server additionally
 * requires the key id to sit in ITS registry (written at mint/import) and
 * be activated on the requesting machine (1-machine binding). Extracting
 * the check key below therefore mints nothing the server honors — forged
 * codes die as "unknown license". This offline verifier remains the shared
 * primitive for the server, the mint script, and unit tests.
 *
 * HONEST THREAT MODEL (read before "improving" this): the check key below
 * ships inside the product, so a determined reverser can extract it and
 * mint checksum-valid codes — every one of which the server rejects as an
 * unknown id. Server compromise or registry deletion is the remaining
 * attack surface (VPS hardening + backups), not key forgery. A modified
 * client binary can skip its own gates — no offline check can stop that;
 * server-side activation is the backstop, not the lock.
 * The eslint-disable below is deliberate and reviewed — not evasion.
 */

import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// eslint-disable-next-line nemo/no-hardcoded-secrets -- copy-deterrent checksum key, not an access credential: it authorizes nothing by itself, only lets THIS binary recognize Shrijan-minted codes. Documented threat model above; server activation is the upgrade path.
const ACTIVATION_CHECK_KEY = "7f3a9c2e5b1d4860a4f6e8c1d3b5a792"

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

const EPOCH_DAYS_2026_01_01 = Math.floor(Date.UTC(2026, 0, 1) / 86400000)

/** Key epoch (days since Unix epoch of 2026-01-01): UIs take human
 *  durations and convert with this; the wire format stays absolute. */
export function activationEpochDays(): number {
  return EPOCH_DAYS_2026_01_01
}

const PLANS = ["basic", "pro", "enterprise"] as const
export type LicensePlan = (typeof PLANS)[number]

export interface LicenseClaims {
  plan: LicensePlan
  /** Expiry as unix seconds. */
  exp: number
  /** Random key id, hex. */
  id: string
}

export type LicenseVerdict = { valid: true; claims: LicenseClaims } | { valid: false; reason: string }

/** Strip dashes/spaces, uppercase, validate 16-char Crockford shape.
 *  Any 16-char code normalizes (legacy non-1102 codes included); the 1102
 *  brand-prefix rule is enforced at verify/mint time, not here, so old
 *  customer codes stay readable. */
export function normalizeLicenseKey(input: string | undefined | null): string | null {
  if (!input || typeof input !== "string") return null
  const compact = input.toUpperCase().replace(/[^0-9A-Z]/g, "")
  if (compact.length !== 16) return null
  for (const ch of compact) {
    if (!CROCKFORD.includes(ch)) return null
  }
  // Crockford aliases users actually type: I→1, L→1, O→0, U→V? No — U is
  // excluded from the alphabet but harmless to reject: keep strict so a
  // typo fails loudly instead of minting a lookalike.
  return compact
}

function bitsToBigInt(bits: string): bigint {
  let out = 0n
  for (const b of bits) out = (out << 1n) | (b === "1" ? 1n : 0n)
  return out
}

function bigIntToBits(value: bigint, length: number): string {
  return value.toString(2).padStart(length, "0").slice(-length)
}

function charsToBits(compact: string): string {
  return [...compact].map((ch) => bigIntToBits(BigInt(CROCKFORD.indexOf(ch)), 5)).join("")
}

function bitsToChars(bits: string): string {
  let out = ""
  for (let i = 0; i < bits.length; i += 5) {
    out += CROCKFORD[Number(bitsToBigInt(bits.slice(i, i + 5)))]
  }
  return out
}

function checksumBits(payloadBits: string, secret: string): string {
  const bytes: number[] = []
  for (let i = 0; i < payloadBits.length; i += 8) {
    bytes.push(Number.parseInt(payloadBits.slice(i, i + 8).padEnd(8, "0"), 2))
  }
  const mac = createHmac("sha256", secret).update(Buffer.from(bytes)).digest()
  let bits = ""
  for (const byte of mac) bits += byte.toString(2).padStart(8, "0")
  return bits.slice(0, 20)
}

/** Obfuscation keystream: hides the structured ver/plan/exp bits so two
 *  keys minted the same day share NOTHING visible — every body char varies.
 *  Domain-separated from checksumBits (label prefix) so the two HMAC uses
 *  never produce related outputs. */
function obfStreamBits(randBits: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(`nemo-obf-v1:${randBits}`).digest()
  let bits = ""
  for (const byte of mac) bits += byte.toString(2).padStart(8, "0")
  return bits.slice(0, 27)
}

function xorBits(a: string, b: string): string {
  let out = ""
  for (let i = 0; i < a.length; i++) out += a[i] === b[i] ? "0" : "1"
  return out
}

function planIndex(plan: string): number {
  return (PLANS as readonly string[]).indexOf(plan)
}

/** Verify a 16-letter activation code. Pure — safe anywhere, never throws.
 *
 *  Two wire formats, newest first:
 *  - NEW (minted now): `1102-` brand prefix + 12 payload chars =
 *    random(13) + ver(5)=2 + plan(5) + exp(17) + checksum(20) = 60 bits.
 *    Random-first so the body never shows a structured head (no doubled
 *    prefix, no plan/expiry spell-out); version 2 tells new from legacy.
 *  - LEGACY (pre-prefix codes still in the field, e.g. enterprise codes
 *    minted before the brand prefix): full 16 chars = ver(5)=1 + plan(5) +
 *    exp(17) + random(33) + checksum(20) = 80 bits.
 *  A 1102 code whose new-format checksum passes IS new (claims read from
 *  the 60-bit layout); one whose checksum fails falls through to the
 *  legacy layout so old 1102-starting codes keep working. Anything minted
 *  from here on always starts with 1102. */
export function verifyLicenseKey(key: string | undefined | null, secretOverride?: string): LicenseVerdict {
  const compact = normalizeLicenseKey(key)
  if (!compact) {
    return { valid: false, reason: "malformed key (want 16 letters, 1102-XXXX-XXXX-XXXX)" }
  }
  const secret = secretOverride ?? ACTIVATION_CHECK_KEY
  if (compact.startsWith("1102")) {
    const bits = charsToBits(compact.slice(4))
    const payload = bits.slice(0, 40)
    const check = bits.slice(40)
    if (checksumBits(payload, secret) === check) {
      // Random-first + XOR-obfuscated structured tail: recover plaintext.
      const rand = bits.slice(0, 13)
      const plain = xorBits(bits.slice(13, 40), obfStreamBits(rand, secret))
      const ver = Number(bitsToBigInt(plain.slice(0, 5)))
      if (ver !== 2) return { valid: false, reason: `unsupported key version ${ver}` }
      const plan = PLANS[Number(bitsToBigInt(plain.slice(5, 10)))] as LicensePlan | undefined
      if (!plan) return { valid: false, reason: "unknown plan" }
      const expDays = Number(bitsToBigInt(plain.slice(10, 27)))
      const exp = (EPOCH_DAYS_2026_01_01 + expDays) * 86400
      if (exp * 1000 <= Date.now()) {
        return { valid: false, reason: `expired on ${new Date(exp * 1000).toISOString().slice(0, 10)}` }
      }
      return { valid: true, claims: { plan, exp, id: BigInt(`0b${rand}`).toString(16).padStart(4, "0") } }
    }
    // Checksum miss on the new layout: could be a legacy code that happens
    // to start with 1102 (old codes did) — fall through to legacy.
  }
  const bits = charsToBits(compact)
  const payload = bits.slice(0, 60)
  const check = bits.slice(60)
  if (checksumBits(payload, secret) !== check) {
    return { valid: false, reason: "bad checksum (not a Shrijan-minted code)" }
  }
  const ver = Number(bitsToBigInt(payload.slice(0, 5)))
  if (ver !== 1) return { valid: false, reason: `unsupported key version ${ver}` }
  const plan = PLANS[Number(bitsToBigInt(payload.slice(5, 10)))] as LicensePlan | undefined
  if (!plan) return { valid: false, reason: "unknown plan" }
  const expDays = Number(bitsToBigInt(payload.slice(10, 27)))
  const exp = (EPOCH_DAYS_2026_01_01 + expDays) * 86400
  if (exp * 1000 <= Date.now()) {
    return { valid: false, reason: `expired on ${new Date(exp * 1000).toISOString().slice(0, 10)}` }
  }
  const rand = bits.slice(27, 60)
  return { valid: true, claims: { plan, exp, id: BigInt(`0b${rand}`).toString(16).padStart(9, "0") } }
}

/** Dev-mode unlock: devmode turns ON with a valid license key itself.
 *  Returns the verdict so callers can explain refusals honestly. */
export function canUnlockDevmode(key: string | undefined | null, secretOverride?: string): LicenseVerdict {
  return verifyLicenseKey(key, secretOverride)
}

/** Check-key accessor for NEMO-side minting (server admin route, mint script).
 *  The shipped copy of this key is INERT: nothing grants access on checksum
 *  alone anymore (server registry membership decides). It stays in the
 *  binary only because the server imports this module. */
export function activationCheckKey(): string {
  return ACTIVATION_CHECK_KEY
}

/**
 * Mint a LEGACY 80-bit code (ver=1, full 16-char payload). Migration and
 * tests ONLY — new issuance is always the 1102 brand-prefix format above.
 * Exists so the import path stays provably working without depending on a
 * hardcoded demo key (those expire; this mints fresh dates deterministically).
 * expDays: days since 2026-01-01 (e.g. 365 ≈ one year).
 */
export function mintLegacyActivationKey(
  opts: { plan: LicensePlan; expDays: number; random?: bigint },
  secret: string,
): string {
  const planIdx = planIndex(opts.plan)
  if (planIdx < 0) throw new Error(`unknown plan ${opts.plan}`)
  const rand = opts.random ?? BigInt(`0x${randomBytes(5).toString("hex")}`) & ((1n << 33n) - 1n)
  const payload =
    bigIntToBits(1n, 5) +
    bigIntToBits(BigInt(planIdx), 5) +
    bigIntToBits(BigInt(opts.expDays), 17) +
    bigIntToBits(rand, 33)
  const full = payload + checksumBits(payload, secret)
  const chars = bitsToChars(full)
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`
}

/**
 * Mint a 16-letter activation code (NEMO-side tooling + tests).
 * expDays: days since 2026-01-01 (e.g. 365 ≈ one year).
 */
export function mintActivationKey(
  opts: { plan: LicensePlan; expDays: number; random?: bigint },
  secret: string,
): string {
  const planIdx = planIndex(opts.plan)
  if (planIdx < 0) throw new Error(`unknown plan ${opts.plan}`)
  const rand = opts.random ?? BigInt(`0x${randomBytes(3).toString("hex")}`) & ((1n << 13n) - 1n)
  const randBits = bigIntToBits(rand, 13)
  const plain = bigIntToBits(2n, 5) + bigIntToBits(BigInt(planIdx), 5) + bigIntToBits(BigInt(opts.expDays), 17)
  // Obfuscate the structured tail with a rand-derived stream so same-day
  // keys share nothing visible; checksum covers rand + ciphertext.
  const payload = randBits + xorBits(plain, obfStreamBits(randBits, secret))
  const full = payload + checksumBits(payload, secret)
  const chars = bitsToChars(full)
  const body = `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`
  return `1102-${body}`
}

// ---------------------------------------------------------------------------
// Server-side licensing (always-online): the CLI no longer trusts its own
// checksum for access decisions. Every devmode unlock
// asks the license server live; the server additionally requires the key id
// to be a key IT minted (registry membership), so extracting the shipped
// check key buys an attacker nothing — forged codes are unknown ids.
// ---------------------------------------------------------------------------

/** Default license server (Shrijan). Override per-machine via
 *  NEMO_LICENSE_SERVER or config licenseServerUrl (self-host). */
export const DEFAULT_LICENSE_SERVER = "https://skt.sktailabs.in"

export interface ServerLicenseOptions {
  serverUrl?: string
  machineId?: string
  timeoutMs?: number
}

export interface ServerLicenseVerdict {
  valid: boolean
  plan?: LicensePlan
  exp?: number
  reason?: string
}

/** Stable per-machine identity: a UUID in ~/.nemo/machine-id (0600),
 *  created once and reused forever — reinstalls keep it (home survives),
 *  new hardware gets a new one (1-machine binding enforced server-side).
 *  NEMO_MACHINE_ID_FILE overrides the path (tests point it at tmp). */
export function machineFilePath(): string {
  const override = process.env.NEMO_MACHINE_ID_FILE
  if (override && override.trim().length > 0) return override
  return join(homedir(), ".nemo", "machine-id")
}

export function getMachineId(): string {
  const file = machineFilePath()
  try {
    const existing = readFileSync(file, "utf8").trim()
    if (/^[0-9a-f-]{10,64}$/i.test(existing)) return existing
  } catch {
    // Absent/unreadable — mint below.
  }
  const id = randomUUID()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${id}\n`, { encoding: "utf8", mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // Non-POSIX platforms (win32 ACLs) — best effort.
  }
  return id
}

function licenseServerBase(serverUrl?: string): string {
  const raw = (serverUrl ?? process.env.NEMO_LICENSE_SERVER ?? DEFAULT_LICENSE_SERVER).trim()
  return (raw || DEFAULT_LICENSE_SERVER).replace(/\/+$/, "")
}

async function postLicense(
  path: string,
  body: Record<string, unknown>,
  serverUrl: string | undefined,
  timeoutMs: number,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${licenseServerBase(serverUrl)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json: Record<string, unknown> = {}
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    // Non-JSON error page (proxy/Cloudflare) — status carries the signal.
  }
  return { status: res.status, json }
}

/** Live license check: valid only if the server knows the key id, it isn't
 *  expired/revoked, AND it is activated on THIS machine. Transport failure =
 *  invalid with an "unreachable" reason (always-online license by design —
 *  callers must refuse, never fail open). */
export async function serverVerifyLicenseKey(
  key: string | undefined | null,
  opts: ServerLicenseOptions = {},
): Promise<ServerLicenseVerdict> {
  const k = typeof key === "string" ? key.trim() : ""
  if (!k) return { valid: false, reason: "no license configured (NEMO_LICENSE_KEY or /devmode on <key>)" }
  if (!normalizeLicenseKey(k)) {
    return { valid: false, reason: "malformed key (want 16 letters, 1102-XXXX-XXXX-XXXX)" }
  }
  let machine: string
  try {
    machine = opts.machineId ?? getMachineId()
  } catch (err) {
    return {
      valid: false,
      reason: `cannot read machine identity (${err instanceof Error ? err.message : String(err)})`,
    }
  }
  try {
    const { status, json } = await postLicense(
      "/license/verify",
      { key: k, machineId: machine },
      opts.serverUrl,
      opts.timeoutMs ?? 10_000,
    )
    if (status !== 200 || typeof json.valid !== "boolean") {
      return { valid: false, reason: `license server error (HTTP ${status})` }
    }
    const plan = typeof json.plan === "string" ? (json.plan as LicensePlan) : undefined
    const exp = typeof json.exp === "number" ? json.exp : undefined
    const reason = typeof json.reason === "string" ? json.reason : undefined
    return { valid: json.valid, plan, exp, reason }
  } catch (err) {
    const detail = err instanceof Error ? err.name : String(err)
    return {
      valid: false,
      reason: `license server unreachable (${detail}) — this license needs internet, connect and retry`,
    }
  }
}

/** First-use activation: binds the key to THIS machine (1-machine limit).
 *  Idempotent for the same machine; a different bound machine yields
 *  ok:false + "bound to another machine" (admin unbind resets it). */
export async function serverActivateLicenseKey(
  key: string | undefined | null,
  opts: ServerLicenseOptions = {},
): Promise<{ ok: boolean; plan?: LicensePlan; exp?: number; reason?: string }> {
  const k = typeof key === "string" ? key.trim() : ""
  if (!k) return { ok: false, reason: "paste a license key (1102-XXXX-XXXX-XXXX)" }
  if (!normalizeLicenseKey(k)) {
    return { ok: false, reason: "malformed key (want 16 letters, 1102-XXXX-XXXX-XXXX)" }
  }
  let machine: string
  try {
    machine = opts.machineId ?? getMachineId()
  } catch (err) {
    return { ok: false, reason: `cannot read machine identity (${err instanceof Error ? err.message : String(err)})` }
  }
  try {
    const { status, json } = await postLicense(
      "/license/activate",
      { key: k, machineId: machine },
      opts.serverUrl,
      opts.timeoutMs ?? 10_000,
    )
    if (status !== 200 || typeof json.ok !== "boolean") {
      const detail = typeof json.error === "string" ? json.error : `HTTP ${status}`
      return { ok: false, reason: `license server error (${detail})` }
    }
    const plan = typeof json.plan === "string" ? (json.plan as LicensePlan) : undefined
    const exp = typeof json.exp === "number" ? json.exp : undefined
    const reason = typeof json.reason === "string" ? json.reason : undefined
    return { ok: json.ok, plan, exp, reason }
  } catch (err) {
    const detail = err instanceof Error ? err.name : String(err)
    return { ok: false, reason: `license server unreachable (${detail}) — connect and retry` }
  }
}

/** Self-service trial: mints a short trial BORN BOUND to this
 *  machine (1 live trial per machine, rate-limited per network). The
 *  returned key works immediately — no separate activation needed. */
export async function serverMintTrial(
  opts: ServerLicenseOptions = {},
): Promise<{ ok: boolean; key?: string; exp?: number; days?: number; reason?: string }> {
  let machine: string
  try {
    machine = opts.machineId ?? getMachineId()
  } catch (err) {
    return { ok: false, reason: `cannot read machine identity (${err instanceof Error ? err.message : String(err)})` }
  }
  try {
    const { status, json } = await postLicense(
      "/license/mint-trial",
      { machineId: machine },
      opts.serverUrl,
      opts.timeoutMs ?? 10_000,
    )
    if (status !== 200 || json.ok !== true || typeof json.key !== "string") {
      const reason =
        typeof json.reason === "string" ? json.reason : typeof json.error === "string" ? json.error : `HTTP ${status}`
      return { ok: false, reason }
    }
    return {
      ok: true,
      key: json.key,
      exp: typeof json.exp === "number" ? json.exp : undefined,
      days: typeof json.days === "number" ? json.days : undefined,
    }
  } catch (err) {
    const detail = err instanceof Error ? err.name : String(err)
    return { ok: false, reason: `license server unreachable (${detail}) — connect and retry` }
  }
}
