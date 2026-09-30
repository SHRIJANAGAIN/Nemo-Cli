/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * SQLite state backend (sqliteState flag) — same API surface as the JSON
 * store, verified row-for-row: threads (created_at preserved on update),
 * events (session + since filters, time order), violations (newest first),
 * audit writes, JSON→SQLite migration, and the JSON fallback when the flag
 * is off or node:sqlite is unavailable.
 *
 * Every case runs against a throwaway home. The flag env is saved and
 * restored — ambient FEATURE_SQLITESTATE must never leak between cases.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DatabaseDatabase, resetDatabase, sqliteEngaged, stateFilePath } from "./state_db.js"

const FLAG = "FEATURE_SQLITESTATE"
const savedFlag = process.env[FLAG]

let home: string
let storeFile: string

function open(): DatabaseDatabase {
  return new DatabaseDatabase(storeFile)
}

// ─── Direct node:sqlite access for fixtures and tamper simulation ───

interface RawStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>
  run(...params: unknown[]): unknown
}

interface RawDatabase {
  exec(sql: string): void
  prepare(sql: string): RawStatement
  close(): void
}

/**
 * A raw node:sqlite handle, independent of the store, so tests can build a
 * pre-chain database or tamper with rows exactly as an attacker with SQL
 * access would. Uses `process.getBuiltinModule` to avoid `require` (lint
 * forbids it outside state_db.ts) and a static `node:sqlite` import (which
 * would crash Node 18/20 before the engagement guards can run). Only call
 * after `sqliteEngaged()` returned true — engaged implies a runtime that
 * ships node:sqlite and `getBuiltinModule` (Node 22.3+).
 */
function openRaw(dbFile: string): RawDatabase {
  const proc = process as unknown as { getBuiltinModule?: (id: string) => unknown }
  const mod = typeof proc.getBuiltinModule === "function" ? proc.getBuiltinModule("node:sqlite") : undefined
  const ctor = (mod as { DatabaseSync?: new (path: string) => RawDatabase } | undefined)?.DatabaseSync
  if (!ctor) throw new Error("node:sqlite unavailable")
  return new ctor(dbFile)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "trayambak-sqlite-"))
  storeFile = join(home, "state", "state_1.json")
  resetDatabase()
})

afterEach(() => {
  resetDatabase()
  if (savedFlag === undefined) delete process.env[FLAG]
  else process.env[FLAG] = savedFlag
  rmSync(home, { recursive: true, force: true })
})

describe("backend selection", () => {
  it("stays on JSON while the flag is off", () => {
    delete process.env[FLAG]

    expect(sqliteEngaged()).toBe(false)
    expect(open().backendKind()).toBe("json")
    expect(stateFilePath(home)).toBe(storeFile)
  })

  it("engages SQLite under the flag where the runtime allows it", () => {
    process.env[FLAG] = "1"

    if (!sqliteEngaged()) {
      // Node <22 has no node:sqlite — the honest fallback is JSON.
      expect(open().backendKind()).toBe("json")
      return
    }
    const db = open()
    try {
      expect(db.backendKind()).toBe("sqlite")
      expect(stateFilePath(home)).toBe(join(home, "state", "state_1.db"))
    } finally {
      db.close()
    }
  })
})

describe("sqlite round-trip", () => {
  it("preserves threads, events, violations, and audit rows", () => {
    process.env[FLAG] = "1"
    if (!sqliteEngaged()) return
    const db = open()
    try {
      db.saveThread("t1", { model: "m", turns: 2 })
      db.appendEvent("t1", "message", { text: "hi" })
      db.appendEvent("t1", "message", { text: "yo" })
      db.appendEvent("other", "message", { text: "nope" })
      db.recordViolation("filesystem", "/x", "write", 7)
      db.recordAudit("run", "agent", "bash", "ok")

      expect(db.getThread("t1")?.metadata).toEqual({ model: "m", turns: 2 })
      expect(db.getThread("missing")).toBeNull()
      expect(db.getAllThreads().map((t) => t.id)).toEqual(["t1"])
      expect(db.getEvents("t1")).toHaveLength(2)
      expect(db.getEvents("other")).toHaveLength(1)
      expect(db.getViolations()).toHaveLength(1)
      expect(db.searchThreads("m")).toHaveLength(1)
      expect(db.searchThreads("zzz")).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it("keeps created_at across updates and orders violations newest-first", () => {
    process.env[FLAG] = "1"
    if (!sqliteEngaged()) return
    const db = open()
    try {
      db.saveThread("t1", { v: 1 })
      const created = (db.getThread("t1") as { created_at: number }).created_at
      db.saveThread("t1", { v: 2 })
      expect((db.getThread("t1") as { created_at: number }).created_at).toBe(created)

      db.recordViolation("a", null, "op", 1)
      db.recordViolation("b", null, "op", 1)
      const violations = db.getViolations() as Array<{ type: string }>
      expect(violations.map((v) => v.type)).toEqual(["b", "a"])
    } finally {
      db.close()
    }
  })

  it("persists across close/reopen from the .db file", () => {
    process.env[FLAG] = "1"
    if (!sqliteEngaged()) return
    const first = open()
    first.saveThread("t1", { v: 1 })
    first.close()

    expect(existsSync(join(home, "state", "state_1.db"))).toBe(true)
    const second = open()
    try {
      expect((second.getThread("t1") as { metadata: unknown }).metadata).toEqual({ v: 1 })
    } finally {
      second.close()
    }
  })
})

describe("sqlite migration", () => {
  it("imports existing JSON history on first engagement", () => {
    delete process.env[FLAG]
    const json = open()
    json.saveThread("t1", { model: "m" })
    json.appendEvent("t1", "message", { text: "kept" })
    json.recordViolation("filesystem", "/x", "write", 3)
    json.close()

    process.env[FLAG] = "1"
    if (!sqliteEngaged()) return
    const db = open()
    try {
      expect((db.getThread("t1") as { metadata: unknown }).metadata).toEqual({ model: "m" })
      expect(db.getEvents("t1")).toHaveLength(1)
      expect(db.getViolations()).toHaveLength(1)
    } finally {
      db.close()
    }
  })
})

describe("audit hash chain (sqlite)", () => {
  /** Append `count` audit entries through the public API and close the store. */
  function recordChain(count: number): void {
    const db = open()
    try {
      for (let i = 0; i < count; i++) db.recordAudit(`action.${i}`, "agent", `target.${i}`, "ok")
    } finally {
      db.close()
    }
  }

  /** Read all audit rows through an independent raw connection. */
  function auditRows(dbFile: string): Array<Record<string, unknown>> {
    const raw = openRaw(dbFile)
    try {
      return raw.prepare("SELECT id, action, target, prev_hash, hash FROM audit_log ORDER BY id ASC").all()
    } finally {
      raw.close()
    }
  }

  it("stores linked hashes and verifies after multiple appends", () => {
    process.env[FLAG] = "1"
    if (!sqliteEngaged()) return
    recordChain(3)

    const db = open()
    try {
      expect(db.verifyAuditChain()).toEqual({ ok: true, count: 3 })
    } finally {
      db.close()
    }

    const rows = auditRows(join(home, "state", "state_1.db"))
    expect(rows).toHaveLength(3)
    // Genesis anchor on the first row; every later row carries the previous
    // row's hash — the linkage deletion/reorder detection depends on.
    expect(rows[0]?.prev_hash).toBe("")
    expect(rows[1]?.prev_hash).toBe(rows[0]?.hash)
    expect(rows[2]?.prev_hash).toBe(rows[1]?.hash)
    expect(rows.every((r) => typeof r.hash === "string" && (r.hash as string).length === 64)).toBe(true)
  })

  it("flags an edited middle target at its index", () => {
    process.env[FLAG] = "1"
    if (!sqliteEngaged()) return
    recordChain(3)

    const dbFile = join(home, "state", "state_1.db")
    const raw = openRaw(dbFile)
    try {
      const middle = raw.prepare("SELECT id FROM audit_log ORDER BY id ASC LIMIT 1 OFFSET 1").all()[0]
      raw.prepare("UPDATE audit_log SET target = ? WHERE id = ?").run("tampered", middle?.id)
    } finally {
      raw.close()
    }

    const db = open()
    try {
      expect(db.verifyAuditChain()).toEqual({
        ok: false,
        brokenAt: 1,
        reason: "audit entry hash does not match its contents",
      })
    } finally {
      db.close()
    }
  })

  it("flags a tampered stored hash at its index", () => {
    process.env[FLAG] = "1"
    if (!sqliteEngaged()) return
    recordChain(3)

    const dbFile = join(home, "state", "state_1.db")
    const raw = openRaw(dbFile)
    try {
      const middle = raw.prepare("SELECT id FROM audit_log ORDER BY id ASC LIMIT 1 OFFSET 1").all()[0]
      raw.prepare("UPDATE audit_log SET hash = ? WHERE id = ?").run("0".repeat(64), middle?.id)
    } finally {
      raw.close()
    }

    const db = open()
    try {
      expect(db.verifyAuditChain()).toEqual({
        ok: false,
        brokenAt: 1,
        reason: "audit entry hash does not match its contents",
      })
    } finally {
      db.close()
    }
  })

  it("flags a deleted middle row at the following index", () => {
    process.env[FLAG] = "1"
    if (!sqliteEngaged()) return
    recordChain(3)

    const dbFile = join(home, "state", "state_1.db")
    const raw = openRaw(dbFile)
    try {
      const middle = raw.prepare("SELECT id FROM audit_log ORDER BY id ASC LIMIT 1 OFFSET 1").all()[0]
      raw.prepare("DELETE FROM audit_log WHERE id = ?").run(middle?.id)
    } finally {
      raw.close()
    }

    const db = open()
    try {
      expect(db.verifyAuditChain()).toEqual({
        ok: false,
        brokenAt: 1,
        reason: "prev_hash does not match the expected predecessor",
      })
    } finally {
      db.close()
    }
  })

  it("returns ok after tail truncation — the documented limitation", () => {
    process.env[FLAG] = "1"
    if (!sqliteEngaged()) return
    recordChain(4)

    // Keep only the two oldest rows: the newest entries vanish entirely.
    const dbFile = join(home, "state", "state_1.db")
    const raw = openRaw(dbFile)
    try {
      raw.exec("DELETE FROM audit_log WHERE id > (SELECT id FROM audit_log ORDER BY id ASC LIMIT 1 OFFSET 1)")
    } finally {
      raw.close()
    }

    const db = open()
    try {
      // Pinned on purpose: the prefix still verifies — tail truncation
      // needs an external anchor to become visible (verifyAuditChain doc).
      expect(db.verifyAuditChain()).toEqual({ ok: true, count: 2 })
    } finally {
      db.close()
    }
  })

  it("adds chain columns to a pre-chain database and keeps verifying", () => {
    process.env[FLAG] = "1"
    if (!sqliteEngaged()) return
    const dbFile = join(home, "state", "state_1.db")
    mkdirSync(dirname(dbFile), { recursive: true })

    // Simulate a database created before hash-chaining: table without the
    // two chain columns, one legacy row in it.
    const old = openRaw(dbFile)
    try {
      old.exec(
        "CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, actor TEXT NOT NULL, " +
          "target TEXT NOT NULL, timestamp INTEGER NOT NULL, result TEXT NOT NULL)",
      )
      old
        .prepare("INSERT INTO audit_log(action, actor, target, timestamp, result) VALUES(?, ?, ?, ?, ?)")
        .run("legacy.import", "old", "file", 1700000000000, "ok")
    } finally {
      old.close()
    }

    const db = open()
    try {
      expect(db.backendKind()).toBe("sqlite")
      db.recordAudit("post.migration", "agent", "bash", "ok")
      // Legacy row skipped, new entry chained from genesis: chain intact.
      expect(db.verifyAuditChain()).toEqual({ ok: true, count: 2 })
    } finally {
      db.close()
    }

    const check = openRaw(dbFile)
    try {
      const columns = check
        .prepare("PRAGMA table_info(audit_log)")
        .all()
        .map((c) => c.name)
      expect(columns).toContain("prev_hash")
      expect(columns).toContain("hash")
      const rows = check.prepare("SELECT prev_hash, hash FROM audit_log ORDER BY id ASC").all()
      expect(rows[0]?.hash).toBeNull()
      expect(rows[1]?.prev_hash).toBe("")
      expect(typeof rows[1]?.hash).toBe("string")
    } finally {
      check.close()
    }
  })

  it("keeps the hash chain intact across the JSON → sqlite import", () => {
    delete process.env[FLAG]
    mkdirSync(dirname(storeFile), { recursive: true })
    writeFileSync(
      storeFile,
      JSON.stringify({
        threads: {},
        events: [],
        violations: [],
        seq: 2,
        audit_log: [{ id: 1, action: "legacy", actor: "old", target: "file", timestamp: 1, result: "ok" }],
      }),
      "utf8",
    )
    const json = open()
    json.recordAudit("chained", "agent", "bash", "ok")
    json.close()

    process.env[FLAG] = "1"
    if (!sqliteEngaged()) return
    const db = open()
    try {
      // The chained row keeps its hash through the import (`id` is not
      // hashed); the legacy row arrives as NULL and stays pre-chain.
      expect(db.verifyAuditChain()).toEqual({ ok: true, count: 2 })
    } finally {
      db.close()
    }

    const rows = auditRows(join(home, "state", "state_1.db"))
    expect(rows).toHaveLength(2)
    expect(rows[0]?.hash).toBeNull()
    expect(rows[1]?.prev_hash).toBe("")
    expect(typeof rows[1]?.hash).toBe("string")
  })
})
