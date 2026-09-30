/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * State database — persistent state management.
 *
 * Two backends, one API surface (callers are unaffected):
 * - JSON file (default): the historical store, zero dependencies.
 * - SQLite via node:sqlite (opt-in behind the `sqliteState` feature flag,
 *   `FEATURE_SQLITESTATE=1`): same tables, WAL mode for CLI+TUI
 *   concurrency, with a one-time import from the JSON file so flipping the
 *   flag never loses history. better-sqlite3 is intentionally NOT a
 *   dependency (native compilation would break `npm ci` on machines
 *   without build tools); node:sqlite ships with Node 22+ and is loaded
 *   lazily, so Node 18/20 runtimes keep working on the JSON path.
 *
 * `audit_log` entries are hash-chained in both backends (`prev_hash` +
 * `hash`) so in-place edits become detectable; see `verifyAuditChain` for
 * exactly what the chain does and does not prove.
 */

import { join, dirname } from "path"
import { homedir } from "os"
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from "fs"
import { createHash } from "crypto"
import { isEnabled } from "./feature_flags.js"

interface StoreShape {
  threads: Record<string, { id: string; created_at: number; updated_at: number; metadata: string }>
  events: Array<{ id: number; session_id: string; type: string; payload: string; timestamp: number }>
  violations: Array<{
    id: number
    type: string
    path: string | null
    operation: string
    pid: number
    timestamp: number
  }>
  audit_log: AuditRow[]
  seq: number
}

function emptyStore(): StoreShape {
  return { threads: {}, events: [], violations: [], audit_log: [], seq: 1 }
}

// ─── Audit hash chain (tamper evidence for audit_log) ───

/**
 * The genesis anchor: the first chained entry (or the first entry recorded
 * on a store whose tail predates chaining) hashes against `""`. An empty
 * string is unambiguous next to NULL/absent legacy rows, so no sentinel
 * value has to be invented.
 */
const GENESIS_PREV_HASH = ""

/**
 * One audit row as stored by either backend. `prev_hash` / `hash` are
 * absent (JSON) or NULL (sqlite) on rows written before hash-chaining
 * existed — verification skips those and starts at the first hashed row.
 */
type AuditRow = {
  id: number
  action: string
  actor: string
  target: string
  timestamp: number
  result: string
  prev_hash?: string | null
  hash?: string | null
}

/** The hash-covered fields of one chained audit entry. */
interface AuditChainFields {
  action: string
  actor: string
  target: string
  timestamp: number
  result: string
  prev_hash: string
}

/** Recursively key-sort so nested objects serialize deterministically. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key])
    }
    return sorted
  }
  return value
}

/** Deterministic JSON: object keys sorted at every level, nested included. */
function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/**
 * `hash = sha256(prev_hash + canonicalJSON(entryWithoutHash))` where
 * `entryWithoutHash` is the stored row minus `id` and minus `hash` itself.
 *
 * `id` is excluded because it is a storage artifact: sqlite assigns it via
 * AUTOINCREMENT only at insert time (the hash must already be known by
 * then) and the JSON → sqlite import renumbers rows — a chain must stay
 * valid across backends. Ordering tampering still breaks the `prev_hash`
 * linkage. `prev_hash` stays inside the canonical body as well as in the
 * prefix, and unexpected extra fields land in the body too, so injecting
 * one into a stored row fails recomputation just like an edit does.
 */
function computeAuditHash(entry: AuditChainFields): string {
  const fields: Record<string, unknown> = { ...entry }
  const body: Record<string, unknown> = {}
  for (const key of Object.keys(fields).sort()) {
    if (key === "id" || key === "hash") continue
    body[key] = fields[key]
  }
  return createHash("sha256")
    .update(entry.prev_hash + canonicalJSON(body), "utf8")
    .digest("hex")
}

/** NULL (sqlite) or undefined (JSON) — the field is not stored on this row. */
function isMissing(value: string | null | undefined): value is null | undefined {
  return value === null || value === undefined
}

/** The hash-covered fields of the next audit entry; the clock reads now. */
function auditChainEntry(
  action: string,
  actor: string,
  target: string,
  result: string,
  prev_hash: string,
): AuditChainFields {
  return { action, actor, target, timestamp: Date.now(), result, prev_hash }
}

/** Result of recomputing a stored audit chain — see `verifyAuditChain`. */
export type AuditChainResult = { ok: true; count: number } | { ok: false; brokenAt: number; reason: string }

/**
 * Walk audit rows in stored order, recomputing each hash. Returns the first
 * index that fails or, when everything links, the number of rows examined
 * (`count`, including any pre-chain rows, which carry no evidence).
 */
function verifyChainRows(rows: AuditRow[]): AuditChainResult {
  let expectedPrev = GENESIS_PREV_HASH
  let chainStarted = false
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    // Optional access so a non-object row (corrupt JSON) is judged by its
    // fields instead of crashing the verifier.
    const prevHash = row?.prev_hash
    const storedHash = row?.hash
    if (isMissing(prevHash) && isMissing(storedHash)) {
      // Pre-chain row: written before chaining existed, no tamper evidence.
      if (chainStarted) {
        return { ok: false, brokenAt: i, reason: "unhashed audit entry appears after the chain began" }
      }
      continue
    }
    if (isMissing(storedHash)) {
      return { ok: false, brokenAt: i, reason: "audit entry has prev_hash but no hash" }
    }
    if (isMissing(prevHash)) {
      return { ok: false, brokenAt: i, reason: "audit entry has hash but no prev_hash" }
    }
    if (prevHash !== expectedPrev) {
      return { ok: false, brokenAt: i, reason: "prev_hash does not match the expected predecessor" }
    }
    if (computeAuditHash({ ...row, prev_hash: prevHash }) !== storedHash) {
      return { ok: false, brokenAt: i, reason: "audit entry hash does not match its contents" }
    }
    chainStarted = true
    expectedPrev = storedHash
  }
  return { ok: true, count: rows.length }
}

/** Default state home directory. */
function getCodexHome(): string {
  return join(homedir(), ".trayambak")
}

function storePath(codexHome?: string): string {
  return join(codexHome ?? getCodexHome(), "state", "state_1.json")
}

function sqlitePath(codexHome?: string): string {
  return join(codexHome ?? getCodexHome(), "state", "state_1.db")
}

/**
 * Absolute path of the LIVE state file. Exported for `trayambak db path`
 * and diagnostics — flag-aware: the SQLite file while the sqliteState flag
 * engages it, otherwise the JSON file.
 */
export function stateFilePath(codexHome?: string): string {
  return sqliteEngaged() ? sqlitePath(codexHome) : storePath(codexHome)
}

function loadStore(file: string): StoreShape {
  try {
    if (!existsSync(file)) return emptyStore()
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoreShape>
    return { ...emptyStore(), ...parsed }
  } catch {
    return emptyStore()
  }
}

function saveStore(file: string, store: StoreShape): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(store), { encoding: "utf8", mode: 0o600 })
  try {
    renameSync(tmp, file)
    try {
      chmodSync(file, 0o600)
    } catch {
      /* non-POSIX */
    }
  } catch {
    writeFileSync(file, JSON.stringify(store), "utf8")
  }
}

// ─── SQLite backend (flag-gated, lazily loaded) ───

/** Structural node:sqlite surface — no @types/node version coupling. */
interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined
  all(...params: unknown[]): Array<Record<string, unknown>>
  run(...params: unknown[]): unknown
}

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

type SqliteConstructor = new (path: string) => SqliteDatabase

let sqliteCtor: SqliteConstructor | null | undefined

function loadSqlite(): SqliteConstructor | null {
  if (sqliteCtor !== undefined) return sqliteCtor
  try {
    // Dynamic load keeps Node 18/20 on the JSON path; require is fine in CJS.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("node:sqlite") as { DatabaseSync?: SqliteConstructor }
    sqliteCtor = mod.DatabaseSync ?? null
  } catch {
    sqliteCtor = null
  }
  return sqliteCtor
}

/** True when the SQLite path should engage (flag on + runtime capable). */
export function sqliteEngaged(): boolean {
  return isEnabled("sqliteState") && loadSqlite() !== null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS violations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  path TEXT,
  operation TEXT NOT NULL,
  pid INTEGER NOT NULL,
  timestamp INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  target TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  result TEXT NOT NULL,
  prev_hash TEXT,
  hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_violations_ts ON violations(timestamp);
`

/**
 * `CREATE TABLE IF NOT EXISTS` never adds columns to a table that already
 * exists, so databases created before hash-chaining get `prev_hash` and
 * `hash` here — one guarded ALTER per column (sqlite adds one column per
 * ALTER statement). A duplicate-column error means the column is already
 * present: the expected outcome on every fresh schema and repeat open.
 * Anything else propagates, and `DatabaseDatabase` falls back to the JSON
 * backend rather than running a half-migrated store.
 */
function ensureAuditChainColumns(db: SqliteDatabase): void {
  for (const column of ["prev_hash", "hash"]) {
    try {
      db.exec(`ALTER TABLE audit_log ADD COLUMN ${column} TEXT`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!message.includes("duplicate column")) throw err
    }
  }
}

/**
 * One-time JSON → SQLite import so enabling the flag never strands
 * history in the old file. Best-effort per row; failures fall back to an
 * empty store rather than breaking construction.
 */
function migrateJsonToSqlite(db: SqliteDatabase, jsonFile: string): void {
  let store: StoreShape
  try {
    if (!existsSync(jsonFile)) return
    store = loadStore(jsonFile)
  } catch {
    return
  }
  try {
    const saveThread = db.prepare(
      "INSERT OR REPLACE INTO threads(id, created_at, updated_at, metadata) VALUES(?, ?, ?, ?)",
    )
    for (const thread of Object.values(store.threads)) {
      try {
        saveThread.run(thread.id, thread.created_at, thread.updated_at, thread.metadata)
      } catch {
        /* one bad row must not abort the import */
      }
    }
    const saveEvent = db.prepare("INSERT INTO events(session_id, type, payload, timestamp) VALUES(?, ?, ?, ?)")
    for (const event of store.events) {
      try {
        saveEvent.run(event.session_id, event.type, event.payload, event.timestamp)
      } catch {
        /* ignore */
      }
    }
    const saveViolation = db.prepare(
      "INSERT INTO violations(type, path, operation, pid, timestamp) VALUES(?, ?, ?, ?, ?)",
    )
    for (const violation of store.violations) {
      try {
        saveViolation.run(violation.type, violation.path, violation.operation, violation.pid, violation.timestamp)
      } catch {
        /* ignore */
      }
    }
    const saveAudit = db.prepare(
      "INSERT INTO audit_log(action, actor, target, timestamp, result, prev_hash, hash) VALUES(?, ?, ?, ?, ?, ?, ?)",
    )
    for (const entry of store.audit_log) {
      try {
        // Chained rows keep their hashes so the chain survives the import
        // (`id` is not hashed, so renumbering on this side is harmless);
        // pre-chain rows import as NULL and stay unverifiable as before.
        saveAudit.run(
          entry.action,
          entry.actor,
          entry.target,
          entry.timestamp,
          entry.result,
          entry.prev_hash ?? null,
          entry.hash ?? null,
        )
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* import is best-effort */
  }
}

// ─── Backend interface (both stores honor it) ───

interface StateBackend {
  readonly kind: "json" | "sqlite"
  saveThread(id: string, metadata: Record<string, unknown>): void
  getThread(id: string): Record<string, unknown> | null
  getAllThreads(): Record<string, unknown>[]
  appendEvent(sessionId: string, type: string, payload: Record<string, unknown>): void
  getEvents(sessionId: string, since?: number): Record<string, unknown>[]
  recordViolation(type: string, path: string | null, operation: string, pid: number): void
  getViolations(since?: number): Record<string, unknown>[]
  recordAudit(action: string, actor: string, target: string, result: string): void
  verifyAuditChain(): AuditChainResult
  searchThreads(query: string): Record<string, unknown>[]
  close(): void
}

/**
 * Historical JSON-file backend — same store and semantics as the file
 * store always had; audit rows additionally carry the hash chain.
 */
class JsonBackend implements StateBackend {
  readonly kind = "json" as const
  private readonly file: string
  private store: StoreShape

  constructor(file: string) {
    this.file = file
    this.store = loadStore(this.file)
  }

  private persist(): void {
    try {
      saveStore(this.file, this.store)
    } catch {
      /* state must never break the CLI */
    }
  }

  saveThread(id: string, metadata: Record<string, unknown>): void {
    const now = Date.now()
    const prev = this.store.threads[id]
    this.store.threads[id] = {
      id,
      created_at: prev?.created_at ?? now,
      updated_at: now,
      metadata: JSON.stringify(metadata),
    }
    this.persist()
  }

  getThread(id: string): Record<string, unknown> | null {
    const row = this.store.threads[id]
    if (!row) return null
    return { ...row, metadata: JSON.parse(row.metadata as string) }
  }

  getAllThreads(): Record<string, unknown>[] {
    return Object.values(this.store.threads)
      .sort((a, b) => b.updated_at - a.updated_at)
      .map((r) => ({ ...r, metadata: JSON.parse(r.metadata as string) }))
  }

  appendEvent(sessionId: string, type: string, payload: Record<string, unknown>): void {
    this.store.events.push({
      id: this.store.seq++,
      session_id: sessionId,
      type,
      payload: JSON.stringify(payload),
      timestamp: Date.now(),
    })
    this.persist()
  }

  getEvents(sessionId: string, since?: number): Record<string, unknown>[] {
    return this.store.events
      .filter((e) => e.session_id === sessionId && (since === undefined || e.timestamp >= since))
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  recordViolation(type: string, path: string | null, operation: string, pid: number): void {
    this.store.violations.push({ id: this.store.seq++, type, path, operation, pid, timestamp: Date.now() })
    this.persist()
  }

  getViolations(since?: number): Record<string, unknown>[] {
    return this.store.violations
      .filter((v) => since === undefined || v.timestamp >= since)
      .sort((a, b) => (b.timestamp as number) - (a.timestamp as number))
  }

  /** Tail hash for the next entry: `""` when empty or pre-chain. */
  private lastAuditHash(): string {
    const last = this.store.audit_log[this.store.audit_log.length - 1]
    return typeof last?.hash === "string" ? last.hash : GENESIS_PREV_HASH
  }

  recordAudit(action: string, actor: string, target: string, result: string): void {
    const fields = auditChainEntry(action, actor, target, result, this.lastAuditHash())
    this.store.audit_log.push({ id: this.store.seq++, ...fields, hash: computeAuditHash(fields) })
    this.persist()
  }

  verifyAuditChain(): AuditChainResult {
    return verifyChainRows(this.store.audit_log)
  }

  searchThreads(query: string): Record<string, unknown>[] {
    const q = query.toLowerCase()
    return this.getAllThreads()
      .filter((t) => JSON.stringify(t).toLowerCase().includes(q))
      .slice(0, 20)
  }

  close(): void {
    try {
      this.persist()
    } catch {
      /* ignore */
    }
  }
}

/** SQLite backend — same rows, real queries, WAL for CLI+TUI concurrency. */
class SqliteBackend implements StateBackend {
  readonly kind = "sqlite" as const
  private readonly db: SqliteDatabase

  constructor(dbFile: string, jsonFile: string) {
    mkdirSync(dirname(dbFile), { recursive: true })
    const Ctor = loadSqlite()
    if (!Ctor) throw new Error("node:sqlite unavailable")
    const fresh = !existsSync(dbFile)
    this.db = new Ctor(dbFile)
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;")
    this.db.exec(SCHEMA)
    ensureAuditChainColumns(this.db)
    if (fresh) migrateJsonToSqlite(this.db, jsonFile)
  }

  saveThread(id: string, metadata: Record<string, unknown>): void {
    const now = Date.now()
    const prev = this.db.prepare("SELECT created_at FROM threads WHERE id = ?").get(id) as
      { created_at: number } | undefined
    this.db
      .prepare(
        "INSERT INTO threads(id, created_at, updated_at, metadata) VALUES(?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, metadata = excluded.metadata",
      )
      .run(id, prev?.created_at ?? now, now, JSON.stringify(metadata))
  }

  getThread(id: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT id, created_at, updated_at, metadata FROM threads WHERE id = ?").get(id) as
      { id: string; created_at: number; updated_at: number; metadata: string } | undefined
    if (!row) return null
    return { ...row, metadata: JSON.parse(row.metadata) }
  }

  getAllThreads(): Record<string, unknown>[] {
    const rows = this.db
      .prepare("SELECT id, created_at, updated_at, metadata FROM threads ORDER BY updated_at DESC")
      .all() as Array<{ id: string; created_at: number; updated_at: number; metadata: string }>
    return rows.map((r) => ({ ...r, metadata: JSON.parse(r.metadata) }))
  }

  appendEvent(sessionId: string, type: string, payload: Record<string, unknown>): void {
    this.db
      .prepare("INSERT INTO events(session_id, type, payload, timestamp) VALUES(?, ?, ?, ?)")
      .run(sessionId, type, JSON.stringify(payload), Date.now())
  }

  getEvents(sessionId: string, since?: number): Record<string, unknown>[] {
    if (since === undefined) {
      return this.db
        .prepare(
          "SELECT id, session_id, type, payload, timestamp FROM events WHERE session_id = ? ORDER BY timestamp ASC",
        )
        .all(sessionId)
    }
    return this.db
      .prepare(
        "SELECT id, session_id, type, payload, timestamp FROM events WHERE session_id = ? AND timestamp >= ? ORDER BY timestamp ASC",
      )
      .all(sessionId, since)
  }

  recordViolation(type: string, path: string | null, operation: string, pid: number): void {
    this.db
      .prepare("INSERT INTO violations(type, path, operation, pid, timestamp) VALUES(?, ?, ?, ?, ?)")
      .run(type, path, operation, pid, Date.now())
  }

  getViolations(since?: number): Record<string, unknown>[] {
    if (since === undefined) {
      return this.db
        .prepare("SELECT id, type, path, operation, pid, timestamp FROM violations ORDER BY timestamp DESC")
        .all()
    }
    return this.db
      .prepare(
        "SELECT id, type, path, operation, pid, timestamp FROM violations WHERE timestamp >= ? ORDER BY timestamp DESC",
      )
      .all(since)
  }

  /** Tail hash for the next entry: `""` when empty or pre-chain. */
  private lastAuditHash(): string {
    const row = this.db.prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1").get()
    const hash = row?.hash
    return typeof hash === "string" ? hash : GENESIS_PREV_HASH
  }

  recordAudit(action: string, actor: string, target: string, result: string): void {
    const fields = auditChainEntry(action, actor, target, result, this.lastAuditHash())
    const hash = computeAuditHash(fields)
    this.db
      .prepare(
        "INSERT INTO audit_log(action, actor, target, timestamp, result, prev_hash, hash) VALUES(?, ?, ?, ?, ?, ?, ?)",
      )
      .run(fields.action, fields.actor, fields.target, fields.timestamp, fields.result, fields.prev_hash, hash)
  }

  verifyAuditChain(): AuditChainResult {
    const rows = this.db
      .prepare("SELECT id, action, actor, target, timestamp, result, prev_hash, hash FROM audit_log ORDER BY id ASC")
      .all() as AuditRow[]
    return verifyChainRows(rows)
  }

  searchThreads(query: string): Record<string, unknown>[] {
    const q = query.toLowerCase()
    return this.getAllThreads()
      .filter((t) => JSON.stringify(t).toLowerCase().includes(q))
      .slice(0, 20)
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Database handle wrapper providing typed access to the state store.
 * The constructor contract is unchanged (JSON store path, real or
 * throwaway); the SQLite file is its sibling with a .db extension.
 */
export class DatabaseDatabase {
  private readonly backend: StateBackend

  constructor(file?: string) {
    const jsonFile = file ?? storePath()
    let backend: StateBackend
    if (sqliteEngaged()) {
      try {
        const dbFile = jsonFile.toLowerCase().endsWith(".json")
          ? jsonFile.slice(0, -".json".length) + ".db"
          : `${jsonFile}.db`
        backend = new SqliteBackend(dbFile, jsonFile)
      } catch {
        backend = new JsonBackend(jsonFile)
      }
    } else {
      backend = new JsonBackend(jsonFile)
    }
    this.backend = backend
  }

  /** Which store is live: "json" (default) or "sqlite" (flag-gated). */
  backendKind(): "json" | "sqlite" {
    return this.backend.kind
  }

  saveThread(id: string, metadata: Record<string, unknown>): void {
    this.backend.saveThread(id, metadata)
  }

  getThread(id: string): Record<string, unknown> | null {
    return this.backend.getThread(id)
  }

  getAllThreads(): Record<string, unknown>[] {
    return this.backend.getAllThreads()
  }

  appendEvent(sessionId: string, type: string, payload: Record<string, unknown>): void {
    this.backend.appendEvent(sessionId, type, payload)
  }

  getEvents(sessionId: string, since?: number): Record<string, unknown>[] {
    return this.backend.getEvents(sessionId, since)
  }

  recordViolation(type: string, path: string | null, operation: string, pid: number): void {
    this.backend.recordViolation(type, path, operation, pid)
  }

  getViolations(since?: number): Record<string, unknown>[] {
    return this.backend.getViolations(since)
  }

  recordAudit(action: string, actor: string, target: string, result: string): void {
    this.backend.recordAudit(action, actor, target, result)
  }

  /**
   * Recompute this store's audit hash chain. See the exported
   * `verifyAuditChain` below for exactly what a passing result proves.
   */
  verifyAuditChain(): AuditChainResult {
    return this.backend.verifyAuditChain()
  }

  searchThreads(query: string): Record<string, unknown>[] {
    return this.backend.searchThreads(query)
  }

  close(): void {
    try {
      this.backend.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Recompute `db`'s audit hash chain in stored order: `{ ok: true, count }`
 * when every entry links (`count` = rows examined, including pre-chain rows,
 * which carry no evidence), otherwise `{ ok: false, brokenAt, reason }` with
 * the index of the first entry that fails.
 *
 * What a passing chain proves — and honestly nothing more:
 * - In-place edits of a chained entry's fields fail recomputation; edits to
 *   a stored `hash` fail recomputation; deleting or reordering a middle
 *   entry breaks the next entry's `prev_hash` linkage. All of those are
 *   reported at the offending index.
 * - Tail truncation (deleting the NEWEST entries) is NOT detectable here:
 *   every remaining entry still verifies, so this returns `ok`. Detecting
 *   truncation requires an external anchor — a head hash recorded somewhere
 *   the attacker cannot rewrite (a signed log, a monitoring pipeline,
 *   another host).
 * - An attacker who rewrites an entire suffix of entries and recomputes
 *   every subsequent hash also produces a chain that verifies. An unanchored
 *   chain cannot prevent a full rewrite; it only makes partial tampering
 *   that was not re-hashed visible.
 * - Rows written before chaining existed (legacy JSON stores and databases
 *   imported from them) have no `prev_hash`/`hash` and provide no evidence;
 *   verification starts at the first hashed row. This is tamper evidence
 *   for chained writes — it is NOT an append-only store, and nothing here
 *   freezes the table against ordinary SQL writes.
 *
 * Re-exported through `packages/core/src/index.ts` (`export *`).
 */
export function verifyAuditChain(db: DatabaseDatabase): AuditChainResult {
  return db.verifyAuditChain()
}

/**
 * Initialize the state store (creates directories; no native deps).
 */
export function initDatabases(codexHome?: string): DatabaseDatabase {
  return new DatabaseDatabase(codexHome ? join(codexHome, "state", "state_1.json") : undefined)
}

/**
 * Get a singleton database instance.
 */
let _dbInstance: DatabaseDatabase | null = null

export function getDatabase(codexHome?: string): DatabaseDatabase {
  if (!_dbInstance) {
    _dbInstance = initDatabases(codexHome)
  }
  return _dbInstance
}

/**
 * Reset the database singleton (useful for testing).
 */
export function resetDatabase(): void {
  if (_dbInstance) {
    try {
      _dbInstance.close()
    } catch {
      /* ignore */
    }
    _dbInstance = null
  }
}
