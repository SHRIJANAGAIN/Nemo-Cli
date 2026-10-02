/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * State store behaviour.
 *
 * Every case runs against a throwaway `codexHome` under the OS temp dir.
 * `getDatabase()` with no argument resolves to `~/.trayambak/state/state_1.json`,
 * so a test that reads or writes the default store leaks fixtures into the
 * developer's real state — which is exactly how a thread named `test-1`
 * reached production. The last case guards that isolation.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { spawn } from "child_process"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DatabaseDatabase, getDatabase, initDatabases, resetDatabase, verifyAuditChain } from "./state_db.js"

let home: string
let storeFile: string

/** Construct a store rooted at `home`, bypassing the singleton. */
function open(): DatabaseDatabase {
  return initDatabases(home)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "trayambak-state-"))
  storeFile = join(home, "state", "state_1.json")
  resetDatabase()
})

afterEach(() => {
  resetDatabase()
  rmSync(home, { recursive: true, force: true })
})

describe("thread records", () => {
  it("round-trips metadata values rather than just their presence", () => {
    const db = open()
    db.saveThread("t1", { model: "gpt-5", turns: 7, nested: { a: 1 } })
    const thread = db.getThread("t1")
    expect(thread).not.toBeNull()
    expect(thread?.metadata).toEqual({ model: "gpt-5", turns: 7, nested: { a: 1 } })
    expect(thread?.id).toBe("t1")
  })

  it("returns null for a thread that was never saved", () => {
    expect(open().getThread("missing")).toBeNull()
  })

  it("preserves created_at on update while advancing updated_at", async () => {
    const db = open()
    db.saveThread("t1", { v: 1 })
    const created = (db.getThread("t1") as { created_at: number }).created_at
    await new Promise((r) => setTimeout(r, 15))
    db.saveThread("t1", { v: 2 })
    const after = db.getThread("t1") as {
      created_at: number
      updated_at: number
      metadata: unknown
    }
    expect(after.created_at).toBe(created)
    expect(after.updated_at).toBeGreaterThanOrEqual(created)
    expect(after.metadata).toEqual({ v: 2 })
  })

  it("orders threads by most recently updated", async () => {
    const db = open()
    db.saveThread("older", { n: 1 })
    await new Promise((r) => setTimeout(r, 15))
    db.saveThread("newer", { n: 2 })
    expect(db.getAllThreads().map((t) => t.id)).toEqual(["newer", "older"])
  })
})

describe("event log", () => {
  it("scopes events to their session", () => {
    const db = open()
    db.appendEvent("s1", "tool", { name: "bash" })
    db.appendEvent("s2", "tool", { name: "read" })
    const s1 = db.getEvents("s1")
    expect(s1).toHaveLength(1)
    // Unlike getThread, which parses `metadata`, getEvents hands back `payload`
    // exactly as appendEvent wrote it. Documented so a caller knows to parse.
    expect(s1[0]?.payload).toBe('{"name":"bash"}')
    expect(db.getEvents("s2")).toHaveLength(1)
    expect(db.getEvents("s3")).toHaveLength(0)
  })

  it("filters by the since timestamp", async () => {
    const db = open()
    db.appendEvent("s1", "old", {})
    // Records share a millisecond if written back to back, so the cutoff is
    // bracketed by sleeps rather than guessed at with Date.now() + 1.
    await new Promise((r) => setTimeout(r, 10))
    const cut = Date.now()
    await new Promise((r) => setTimeout(r, 10))
    db.appendEvent("s1", "new", {})
    expect(db.getEvents("s1", cut).map((e) => e.type)).toEqual(["new"])
    expect(db.getEvents("s1")).toHaveLength(2)
  })

  it("returns events in chronological order", async () => {
    const db = open()
    db.appendEvent("s1", "first", {})
    await new Promise((r) => setTimeout(r, 5))
    db.appendEvent("s1", "second", {})
    expect(db.getEvents("s1").map((e) => e.type)).toEqual(["first", "second"])
  })
})

describe("violations and audit trail", () => {
  it("records violation fields verbatim", () => {
    const db = open()
    db.recordViolation("filesystem", "/etc/passwd", "read", 4242)
    const [v] = db.getViolations() as Array<Record<string, unknown>>
    expect(v).toMatchObject({
      type: "filesystem",
      path: "/etc/passwd",
      operation: "read",
      pid: 4242,
    })
    expect(v?.id).toBeTypeOf("number")
    expect(v?.timestamp).toBeTypeOf("number")
  })

  it("supports a null path for violations without one", () => {
    open().recordViolation("network", null, "connect", 1)
    const [v] = new DatabaseDatabase(storeFile).getViolations() as Array<{ path: string | null }>
    expect(v?.path).toBeNull()
  })

  it("sorts violations newest first and honours since", async () => {
    const db = open()
    db.recordViolation("a", null, "x", 1)
    await new Promise((r) => setTimeout(r, 10))
    db.recordViolation("b", null, "y", 2)
    // Descending by timestamp, so the two are spaced rather than left to a
    // stable sort over equal millisecond values.
    expect(db.getViolations().map((v) => v.type)).toEqual(["b", "a"])
    await new Promise((r) => setTimeout(r, 10))
    const cut = Date.now()
    await new Promise((r) => setTimeout(r, 10))
    db.recordViolation("c", null, "z", 3)
    expect(db.getViolations(cut).map((v) => v.type)).toEqual(["c"])
  })

  it("persists the audit trail to the store file", () => {
    const db = open()
    db.recordAudit("tool.execute", "agent", "bash", "success")
    db.close()
    const raw = JSON.parse(readFileSync(storeFile, "utf8")) as {
      audit_log: Array<Record<string, unknown>>
    }
    expect(raw.audit_log).toHaveLength(1)
    expect(raw.audit_log[0]).toMatchObject({
      action: "tool.execute",
      actor: "agent",
      target: "bash",
      result: "success",
    })
  })
})

describe("search", () => {
  it("matches thread content case-insensitively", () => {
    const db = open()
    db.saveThread("a", { note: "Always REBASE before merging" })
    db.saveThread("b", { note: "unrelated" })
    const hits = db.searchThreads("rebase")
    expect(hits.map((t) => t.id)).toEqual(["a"])
  })

  it("returns nothing when nothing matches", () => {
    const db = open()
    db.saveThread("a", { note: "x" })
    expect(db.searchThreads("zzz-not-present")).toEqual([])
  })

  it("caps results at 20", () => {
    const db = open()
    for (let i = 0; i < 30; i++) db.saveThread(`t${i}`, { blob: "needle" })
    expect(db.searchThreads("needle")).toHaveLength(20)
  })
})

describe("persistence and recovery", () => {
  it("survives reopening the store from disk", () => {
    open().saveThread("persist-1", { model: "m" })
    const reopened = new DatabaseDatabase(storeFile)
    expect(reopened.getThread("persist-1")?.metadata).toEqual({ model: "m" })
  })

  it("recovers from a corrupt store instead of throwing", () => {
    mkdirSync(dirname(storeFile), { recursive: true })
    writeFileSync(storeFile, "{ this is not json", "utf8")
    const recovered = open()
    expect(recovered.getAllThreads()).toEqual([])
    recovered.saveThread("after-corrupt", { ok: true })
    expect(open().getThread("after-corrupt")).not.toBeNull()
  })

  it("starts empty when no store file exists", () => {
    expect(existsSync(storeFile)).toBe(false)
    expect(open().getAllThreads()).toEqual([])
  })

  const nonWindows = process.platform === "win32" ? it.skip : it
  nonWindows("restricts the store file to its owner", () => {
    open().saveThread("perms", {})
    expect(statSync(storeFile).mode & 0o777).toBe(0o600)
  })
})

/**
 * Multi-handle and multi-process safety (#65): every mutation reloads disk
 * state under a cross-process claim, so a second writer can never erase what
 * the first appended — and the hash-chained audit trail survives both
 * interleaved handles and real concurrent processes.
 */
describe("cross-handle and cross-process safety (#65)", () => {
  it("a second handle does not erase rows the first wrote (no lost update)", () => {
    const a = open()
    const b = open() // same shape as a second process: its own instance, one file
    a.saveThread("from-a", { who: "a" })
    b.saveThread("from-b", { who: "b" })
    expect(b.getThread("from-a")?.metadata).toEqual({ who: "a" }) // b reloaded, not clobbered
    expect(a.getThread("from-b")?.metadata).toEqual({ who: "b" })
    expect(open().getThread("from-a")).not.toBeNull()
    expect(open().getThread("from-b")).not.toBeNull()
  })

  it("interleaved handles append to ONE valid chain instead of forking or losing entries", () => {
    const a = open()
    const b = open()
    a.recordAudit("one", "a", "t1", "ok")
    b.recordAudit("two", "b", "t2", "ok") // old code: chains off a stale tail AND overwrites "one"
    a.recordAudit("three", "a", "t3", "ok")
    expect(verifyAuditChain(open())).toEqual({ ok: true, count: 3 })
  })

  it("closing one handle does not erase rows another handle wrote after it", () => {
    const a = open()
    a.recordAudit("first", "a", "t1", "ok")
    const b = open()
    b.recordAudit("later", "b", "t2", "ok")
    a.close() // old code: exit-time flush from a's stale snapshot wiped "later"
    expect(verifyAuditChain(open())).toEqual({ ok: true, count: 2 })
  })

  it("quarantines a corrupt store instead of letting the next save destroy it", () => {
    mkdirSync(dirname(storeFile), { recursive: true })
    writeFileSync(storeFile, "{ this is not json", "utf8")
    const db = open()
    expect(db.getAllThreads()).toEqual([]) // still recovers without throwing
    db.saveThread("after-corrupt", { ok: true })
    const stateDir = dirname(storeFile)
    const backups = readdirSync(stateDir).filter((f) => f.startsWith("state_1.json.corrupt"))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(stateDir, backups[0]!), "utf8")).toBe("{ this is not json")
  })

  it("steals a claim whose owner process is gone", () => {
    mkdirSync(dirname(storeFile), { recursive: true })
    const lock = `${storeFile}.lock`
    writeFileSync(lock, JSON.stringify({ pid: 999_999_999, at: Date.now() }), "utf8")
    const db = open() // must not hang: dead owner → stolen on sight
    db.recordAudit("proceeds", "a", "t", "ok")
    expect(verifyAuditChain(open())).toEqual({ ok: true, count: 1 })
    expect(existsSync(lock)).toBe(false)
  }, 10_000)

  it("gives up on a live foreign claim after the bounded wait instead of blocking the CLI", () => {
    mkdirSync(dirname(storeFile), { recursive: true })
    // The test runner's parent process is alive for the whole test.
    writeFileSync(`${storeFile}.lock`, JSON.stringify({ pid: process.ppid, at: Date.now() }), "utf8")
    const db = open()
    db.recordAudit("fail-open", "a", "t", "ok") // waits ≤2s, then writes anyway
    const raw = JSON.parse(readFileSync(storeFile, "utf8")) as { audit_log: unknown[] }
    expect(raw.audit_log).toHaveLength(1)
  }, 15_000)

  it("two real processes appending concurrently lose nothing and keep one valid chain", async () => {
    // vitest runs from the repo root (its config root), same convention the
    // other tests rely on via process.cwd().
    const repoRoot = process.cwd()
    const viteNode = join(repoRoot, "node_modules", "vite-node", "vite-node.mjs")
    const stateDbPath = join(repoRoot, "packages", "core", "src", "state_db.ts")
    expect(existsSync(viteNode)).toBe(true)
    const worker = join(home, "crossproc-worker.ts")
    writeFileSync(
      worker,
      [
        "const { DatabaseDatabase } = await import(process.env.STATE_DB)",
        "const n = Number(process.env.WORKER_N)",
        "const db = new DatabaseDatabase(process.env.STATE_FILE)",
        "for (let i = 0; i < n; i++) db.recordAudit(`worker.${i}`, 'proc', `pid-${process.pid}`, 'ok')",
        "db.close()",
      ].join("\n"),
      "utf8",
    )
    const runWorker = (n: number): Promise<{ code: number | null; err: string }> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [viteNode, worker], {
          env: { ...process.env, STATE_DB: stateDbPath, STATE_FILE: storeFile, WORKER_N: String(n) },
          cwd: repoRoot,
          stdio: ["ignore", "ignore", "pipe"],
        })
        let err = ""
        child.stderr?.on("data", (chunk: Buffer) => {
          err += String(chunk)
        })
        child.on("close", (code) => resolve({ code, err }))
      })

    const [a, b] = await Promise.all([runWorker(25), runWorker(25)])
    if (a.code !== 0) throw new Error(`worker a failed (${a.code}): ${a.err}`)
    if (b.code !== 0) throw new Error(`worker b failed (${b.code}): ${b.err}`)

    const raw = JSON.parse(readFileSync(storeFile, "utf8")) as { audit_log: Array<{ id: number }> }
    expect(raw.audit_log).toHaveLength(50) // none of the 50 appends was clobbered
    expect(new Set(raw.audit_log.map((r) => r.id)).size).toBe(50) // seq never double-allocated
    const db = new DatabaseDatabase(storeFile)
    expect(db.verifyAuditChain()).toEqual({ ok: true, count: 50 })
    db.close()
  }, 60_000)
})

describe("singleton lifecycle", () => {
  it("hands out one instance until reset", () => {
    const a = getDatabase(home)
    expect(getDatabase(home)).toBe(a)
    resetDatabase()
    expect(getDatabase(home)).not.toBe(a)
  })

  it("ignores a later codexHome once cached", () => {
    const first = getDatabase(home)
    const other = mkdtempSync(join(tmpdir(), "trayambak-other-"))
    try {
      expect(getDatabase(other)).toBe(first)
    } finally {
      resetDatabase()
      rmSync(other, { recursive: true, force: true })
    }
  })

  it("writes only under the supplied home, never the developer's", () => {
    const db = getDatabase(home)
    db.saveThread("isolation-check", { v: 1 })
    db.close()
    // The real store would be ~/.trayambak/state/state_1.json; nothing about
    // this run may reach it, so the fixture must land inside `home`.
    expect(storeFile.startsWith(home)).toBe(true)
    const raw = JSON.parse(readFileSync(storeFile, "utf8")) as { threads: Record<string, unknown> }
    expect(raw.threads["isolation-check"]).toBeDefined()
  })
})

describe("audit hash chain (json)", () => {
  // Like the rest of this file, these cases assume the default backend:
  // pin the sqliteState flag off so an ambient FEATURE_SQLITESTATE can't
  // flip them onto the sqlite store mid-suite.
  const savedFlag = process.env.FEATURE_SQLITESTATE
  beforeEach(() => {
    delete process.env.FEATURE_SQLITESTATE
  })
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.FEATURE_SQLITESTATE
    else process.env.FEATURE_SQLITESTATE = savedFlag
  })

  /** Read the raw store so a test can tamper with it like an attacker would. */
  function readStore(): Record<string, unknown> & { audit_log: Array<Record<string, unknown>> } {
    return JSON.parse(readFileSync(storeFile, "utf8")) as Record<string, unknown> & {
      audit_log: Array<Record<string, unknown>>
    }
  }

  function writeStore(store: Record<string, unknown>): void {
    writeFileSync(storeFile, JSON.stringify(store), "utf8")
  }

  it("verifies an empty store as ok with zero entries", () => {
    expect(verifyAuditChain(open())).toEqual({ ok: true, count: 0 })
  })

  it("verifies linked entries after multiple appends", () => {
    const db = open()
    db.recordAudit("tool.execute", "agent", "bash", "success")
    db.recordAudit("file.write", "agent", "/etc/hosts", "denied")
    db.recordAudit("tool.execute", "agent", "read", "success")
    db.close()

    expect(verifyAuditChain(open())).toEqual({ ok: true, count: 3 })

    const stored = readStore().audit_log
    expect(stored).toHaveLength(3)
    // The first chained entry anchors to the documented genesis value; each
    // later entry carries its predecessor's hash, which is the linkage the
    // deletion/reorder checks hang on.
    expect(stored[0]?.prev_hash).toBe("")
    for (let i = 1; i < stored.length; i++) {
      expect(stored[i]?.prev_hash).toBe(stored[i - 1]?.hash)
    }
    expect(stored.every((e) => typeof e.hash === "string" && e.hash.length === 64)).toBe(true)
  })

  it("flags an edited middle entry at its index", () => {
    const db = open()
    db.recordAudit("a", "agent", "one", "ok")
    db.recordAudit("b", "agent", "two", "ok")
    db.recordAudit("c", "agent", "three", "ok")
    db.close()

    const store = readStore()
    store.audit_log[1].action = "tampered"
    writeStore(store)

    expect(verifyAuditChain(open())).toEqual({
      ok: false,
      brokenAt: 1,
      reason: "audit entry hash does not match its contents",
    })
  })

  it("flags a tampered stored hash at its index", () => {
    const db = open()
    db.recordAudit("a", "agent", "one", "ok")
    db.recordAudit("b", "agent", "two", "ok")
    db.recordAudit("c", "agent", "three", "ok")
    db.close()

    const store = readStore()
    store.audit_log[1].hash = "0".repeat(64)
    writeStore(store)

    expect(verifyAuditChain(open())).toEqual({
      ok: false,
      brokenAt: 1,
      reason: "audit entry hash does not match its contents",
    })
  })

  it("flags a deleted middle entry at the following index", () => {
    const db = open()
    for (const action of ["a", "b", "c"]) db.recordAudit(action, "agent", "target", "ok")
    db.close()

    const store = readStore()
    store.audit_log.splice(1, 1)
    writeStore(store)

    expect(verifyAuditChain(open())).toEqual({
      ok: false,
      brokenAt: 1,
      reason: "prev_hash does not match the expected predecessor",
    })
  })

  it("returns ok after tail truncation — the documented limitation", () => {
    const db = open()
    for (const action of ["a", "b", "c", "d"]) db.recordAudit(action, "agent", "target", "ok")
    db.close()

    const store = readStore()
    store.audit_log.splice(2)
    writeStore(store)

    // Pinned on purpose: the remaining prefix still verifies, so dropping
    // the NEWEST entries is invisible without an external anchor (see the
    // verifyAuditChain doc — this is tamper evidence, not append-only).
    expect(verifyAuditChain(open())).toEqual({ ok: true, count: 2 })
  })

  it("chains onto pre-chain legacy entries without flagging them", () => {
    mkdirSync(dirname(storeFile), { recursive: true })
    writeFileSync(
      storeFile,
      JSON.stringify({
        threads: {},
        events: [],
        violations: [],
        seq: 3,
        audit_log: [
          { id: 1, action: "legacy.import", actor: "old", target: "one", timestamp: 1, result: "ok" },
          { id: 2, action: "legacy.import", actor: "old", target: "two", timestamp: 2, result: "ok" },
        ],
      }),
      "utf8",
    )

    const db = open()
    db.recordAudit("post.migration", "agent", "bash", "ok")
    db.recordAudit("post.migration", "agent", "read", "ok")
    db.close()

    // Legacy rows carry no evidence but do not break verification; the new
    // appends restart from genesis and link to each other.
    expect(verifyAuditChain(open())).toEqual({ ok: true, count: 4 })

    const stored = readStore().audit_log
    expect(stored[0]?.hash).toBeUndefined()
    expect(stored[2]?.prev_hash).toBe("")
    expect(stored[3]?.prev_hash).toBe(stored[2]?.hash)
  })

  it("flags an unhashed entry injected after the chain began", () => {
    const db = open()
    db.recordAudit("a", "agent", "target", "ok")
    db.close()

    const store = readStore()
    store.audit_log.push({ id: 2, action: "forged", actor: "x", target: "y", timestamp: 3, result: "ok" })
    writeStore(store)

    expect(verifyAuditChain(open())).toEqual({
      ok: false,
      brokenAt: 1,
      reason: "unhashed audit entry appears after the chain began",
    })
  })

  it("flags a row with prev_hash but no hash", () => {
    mkdirSync(dirname(storeFile), { recursive: true })
    writeFileSync(
      storeFile,
      JSON.stringify({
        threads: {},
        events: [],
        violations: [],
        seq: 2,
        audit_log: [{ id: 1, action: "a", actor: "b", target: "c", timestamp: 1, result: "ok", prev_hash: "" }],
      }),
      "utf8",
    )

    expect(verifyAuditChain(new DatabaseDatabase(storeFile))).toEqual({
      ok: false,
      brokenAt: 0,
      reason: "audit entry has prev_hash but no hash",
    })
  })

  it("flags a row with hash but no prev_hash", () => {
    mkdirSync(dirname(storeFile), { recursive: true })
    writeFileSync(
      storeFile,
      JSON.stringify({
        threads: {},
        events: [],
        violations: [],
        seq: 2,
        audit_log: [{ id: 1, action: "a", actor: "b", target: "c", timestamp: 1, result: "ok", hash: "0".repeat(64) }],
      }),
      "utf8",
    )

    expect(verifyAuditChain(new DatabaseDatabase(storeFile))).toEqual({
      ok: false,
      brokenAt: 0,
      reason: "audit entry has hash but no prev_hash",
    })
  })
})
