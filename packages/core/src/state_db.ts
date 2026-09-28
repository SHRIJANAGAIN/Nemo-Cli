/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * State database — persistent state management.
 *
 * JSON-file backed store with the same API surface as the SQLite design
 * (threads, events, violations, audit log). SQLite (better-sqlite3) is
 * intentionally NOT a dependency: it needs native compilation and would
 * break `npm ci` on machines without build tools. If better-sqlite3 is
 * ever added, only this file changes — callers are unaffected.
 */

import { join, dirname } from "path"
import { homedir } from "os"
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from "fs"

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
  audit_log: Array<{ id: number; action: string; actor: string; target: string; timestamp: number; result: string }>
  seq: number
}

function emptyStore(): StoreShape {
  return { threads: {}, events: [], violations: [], audit_log: [], seq: 1 }
}

/** Default state home directory. */
function getCodexHome(): string {
  return join(homedir(), ".trayambak")
}

function storePath(codexHome?: string): string {
  return join(codexHome ?? getCodexHome(), "state", "state_1.json")
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

/**
 * Database handle wrapper providing typed access to the state store.
 */
export class DatabaseDatabase {
  private readonly file: string
  private store: StoreShape

  constructor(file?: string) {
    this.file = file ?? storePath()
    this.store = loadStore(this.file)
  }

  private persist(): void {
    try {
      saveStore(this.file, this.store)
    } catch {
      /* state must never break the CLI */
    }
  }

  // --- State operations ---

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

  // --- Event log ---

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

  // --- Violations ---

  recordViolation(type: string, path: string | null, operation: string, pid: number): void {
    this.store.violations.push({ id: this.store.seq++, type, path, operation, pid, timestamp: Date.now() })
    this.persist()
  }

  getViolations(since?: number): Record<string, unknown>[] {
    return this.store.violations
      .filter((v) => since === undefined || v.timestamp >= since)
      .sort((a, b) => (b.timestamp as number) - (a.timestamp as number))
  }

  // --- Audit trail ---

  recordAudit(action: string, actor: string, target: string, result: string): void {
    this.store.audit_log.push({ id: this.store.seq++, action, actor, target, timestamp: Date.now(), result })
    this.persist()
  }

  // --- Search ---

  searchThreads(query: string): Record<string, unknown>[] {
    const q = query.toLowerCase()
    return this.getAllThreads()
      .filter((t) => JSON.stringify(t).toLowerCase().includes(q))
      .slice(0, 20)
  }

  // --- Cleanup ---

  close(): void {
    try {
      this.persist()
    } catch {
      /* ignore */
    }
  }
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
