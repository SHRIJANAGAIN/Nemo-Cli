/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Machine-wide memory of shell chains that cannot survive the OS isolator.
 *
 * The probe that discovers this costs ~14 s on Windows — the AppContainer
 * shim compiles its helper on first use — and the answer is a property of
 * the MACHINE, not of the session. Persisting the negative verdict lets
 * every later process reach the policy path from its first command instead
 * of re-paying the probe on every start.
 *
 * Only NEGATIVE verdicts are persisted: "this shell cannot run under
 * windows-restricted" is a stable property of the shell chain, while a
 * working sandbox must be re-proved per session — a stale "it works"
 * would claim isolation that is no longer there.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

/** A negative verdict stops being authoritative after a week. */
const VERDICT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Refuse to parse an absurd cache file (corrupt or hostile write). */
const MAX_CACHE_BYTES = 256 * 1024

export interface NegativeVerdict {
  ok: false
  reason: string
  /** Node build the verdict was taken on. */
  nodeVersion: string
  /** mtime+size of the shell binary — a new Git Bash re-probes. */
  shellStamp: string
  /** Epoch ms after which the verdict is stale. */
  expiresAt: number
}

/** Stable key for one shell chain. */
export function probeKey(shell: string, shellArgs: string[]): string {
  return [shell, ...shellArgs].join("\u0000")
}

function cachePath(): string {
  const override = process.env.NEMO_SHELL_PROBE_CACHE
  if (override && override.length > 0) return override
  return path.join(os.homedir(), ".nemo", "cache", "shell-probe.json")
}

/** Identity of the shell binary, so an upgrade invalidates the verdict. */
function shellStamp(shell: string): string {
  try {
    const stat = fs.statSync(shell)
    return `${Math.round(stat.mtimeMs)}:${stat.size}`
  } catch {
    return ""
  }
}

function readStore(): Record<string, NegativeVerdict> {
  try {
    const raw = fs.readFileSync(cachePath(), "utf8")
    if (raw.length > MAX_CACHE_BYTES) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const store: Record<string, NegativeVerdict> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const rec = value as Partial<NegativeVerdict>
      if (rec && rec.ok === false && typeof rec.reason === "string") {
        store[key] = {
          ok: false,
          reason: rec.reason,
          nodeVersion: typeof rec.nodeVersion === "string" ? rec.nodeVersion : "",
          shellStamp: typeof rec.shellStamp === "string" ? rec.shellStamp : "",
          expiresAt: typeof rec.expiresAt === "number" ? rec.expiresAt : 0,
        }
      }
    }
    return store
  } catch {
    // No cache, unreadable cache, corrupt cache — all mean "no verdict".
    return {}
  }
}

function writeStore(store: Record<string, NegativeVerdict>): void {
  const target = cachePath()
  const tmp = `${target}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8")
    fs.renameSync(tmp, target)
  } catch {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* the OS temp cleaner will take it */
    }
  }
}

/**
 * The persisted negative verdict for this shell chain, if it still holds.
 *
 * Returns undefined when there is none, when it expired, when the runtime
 * or the shell binary changed, or when `NEMO_SHELL_PROBE_RESET=1` asks for
 * a fresh probe.
 */
export function readPersistedVerdict(
  key: string,
  shell: string,
): { ok: false; reason: string } | undefined {
  if (process.env.NEMO_SHELL_PROBE_RESET === "1") return undefined
  const rec = readStore()[key]
  if (!rec) return undefined
  if (rec.nodeVersion !== process.version) return undefined
  if (rec.shellStamp !== shellStamp(shell)) return undefined
  if (rec.expiresAt <= Date.now()) return undefined
  return { ok: false, reason: rec.reason }
}

/** Remember that this shell chain cannot run under the isolator. */
export function persistNegativeVerdict(key: string, shell: string, reason: string): void {
  try {
    const store = readStore()
    store[key] = {
      ok: false,
      reason,
      nodeVersion: process.version,
      shellStamp: shellStamp(shell),
      expiresAt: Date.now() + VERDICT_TTL_MS,
    }
    writeStore(store)
  } catch {
    // A cache that cannot be written must never fail a command.
  }
}

/** Drop a stale negative verdict once the shell proves it can run. */
export function forgetPersistedVerdict(key: string): void {
  try {
    const store = readStore()
    if (!(key in store)) return
    delete store[key]
    writeStore(store)
  } catch {
    /* best effort */
  }
}
