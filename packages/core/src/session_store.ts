/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Session Store — persistent thread storage with fork, archive, resume, unarchive, delete, migrate.
 *
 * Mirrors codex-thread-store in Rust (codex_thread_store crate).
 * Provides full lifecycle management of conversation threads.
 *
 * Integrity rules (#68, #69):
 *   - Thread ids are validated at the single path chokepoint: an id can
 *     never contain a path separator or start with a dot, so `join(storeDir,
 *     id + ".json")` stays inside the store — no caller (CLI arg, model-
 *     generated name) can read, write, or unlink outside it. Directory
 *     listings only surface ids that pass the same rule, so a stray file
 *     can never break listing.
 *   - Entries are written via tmp + rename (crash can't leave a half JSON
 *     behind; the direct-write fallback keeps the last-resort behaviour of
 *     the old code). On read the stored messages checksum is verified —
 *     a mismatch or unparseable file is quarantined as `<id>.json.corrupt-
 *     <ts>` with its bytes intact instead of silently vanishing (and being
 *     overwritten by the next create with the same id).
 *   - `close()` only drops the cache: every mutation already persisted, and
 *     an exit-time rewrite from a stale cache would clobber rows another
 *     process wrote since.
 *   - Single writer per thread by design (one session owns its thread file,
 *     as in the Rust crate); whole-file last-writer-wins across processes
 *     is expected, not a race to solve here.
 */

import { join, dirname } from "path"
import { homedir } from "os"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "fs"

/**
 * The only shape a thread id may take before it enters a path (#68):
 * leading alphanumerics, then alphanumerics / `.` / `_` / `-`. No `/`, no
 * `\`, no leading dot — traversal (`../../x`), separators, and dotfiles are
 * all unreachable, on every platform, at the one chokepoint below.
 */
const SAFE_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Thread status states. */
export enum ThreadStatus {
  Active = "active",
  Archived = "archived",
  Deleted = "deleted",
  Migrated = "migrated",
}

/** Source of a thread. */
export enum ThreadSource {
  User = "user",
  Model = "model",
  System = "system",
  Fork = "fork",
  Resume = "resume",
}

/** Thread metadata stored in the store. */
export interface ThreadMetadata {
  id: string
  source: ThreadSource
  status: ThreadStatus
  createdAt: number
  updatedAt: number
  forkedFrom?: string
  archivedAt?: number
  migratedAt?: number
  model?: string
  parentThreadId?: string
}

/** A stored thread with its full history. */
export interface StoredThread {
  metadata: ThreadMetadata
  messages: StoredMessage[]
}

/** A single stored message. */
export interface StoredMessage {
  role: string
  content: string
  timestamp: number
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  toolResults?: Array<{ callId: string; result: unknown }>
}

/** Thread store entry for the filesystem. */
interface ThreadStoreEntry {
  metadata: ThreadMetadata
  messages: StoredMessage[]
  checksum: string
}

/**
 * Thread Store — manages persistent thread storage.
 *
 * Mirrors codex-thread-store::PersistContext and codex-thread-store::ReadThreadParams
 * in the Rust implementation.
 *
 * Supports full thread lifecycle:
 * - create, read, update, archive, unarchive, delete, migrate, fork, resume
 */
export class ThreadStore {
  private static instance: ThreadStore | null = null
  private readonly storeDir: string
  private threadCache: Map<string, StoredThread> = new Map()

  private constructor(storeDir?: string) {
    this.storeDir = storeDir ?? join(homedir(), ".trayambak", "threads")
    if (!existsSync(this.storeDir)) {
      mkdirSync(this.storeDir, { recursive: true })
    }
  }

  /** Get the singleton ThreadStore instance. */
  static getInstance(storeDir?: string): ThreadStore {
    if (!ThreadStore.instance) {
      ThreadStore.instance = new ThreadStore(storeDir)
    }
    return ThreadStore.instance
  }

  /**
   * Reset the singleton, optionally pointing it at a different directory.
   *
   * Tests must call this with a temp directory: the default store lives in
   * `~/.trayambak/threads`, so running the suite against the default would
   * clear the user's real conversation history.
   */
  static resetInstance(storeDir?: string): ThreadStore {
    ThreadStore.instance = new ThreadStore(storeDir)
    return ThreadStore.instance
  }

  /**
   * Create a new thread with the given metadata.
   */
  createThread(id: string, metadata: Omit<ThreadMetadata, "id" | "createdAt" | "updatedAt">): StoredThread {
    const now = Date.now()
    const thread: StoredThread = {
      metadata: {
        ...metadata,
        id,
        status: ThreadStatus.Active,
        createdAt: now,
        updatedAt: now,
      },
      messages: [],
    }

    this.persistThread(thread)
    this.threadCache.set(id, thread)
    return thread
  }

  /**
   * Read a thread by ID.
   */
  readThread(id: string): StoredThread | null {
    // Check cache first
    const cached = this.threadCache.get(id)
    if (cached && cached.metadata.status !== ThreadStatus.Deleted) {
      return cached
    }

    // Read from filesystem
    const entry = this.readEntry(id)
    if (!entry || entry.metadata.status === ThreadStatus.Deleted) {
      return null
    }

    const thread: StoredThread = {
      metadata: entry.metadata,
      messages: entry.messages,
    }

    this.threadCache.set(id, thread)
    return thread
  }

  /**
   * Update a thread's metadata and messages.
   */
  updateThread(id: string, updates: Partial<ThreadMetadata>, messages?: StoredMessage[]): StoredThread | null {
    const thread = this.readThread(id)
    if (!thread) return null

    const now = Date.now()
    const updated: StoredThread = {
      metadata: {
        ...thread.metadata,
        ...updates,
        updatedAt: now,
      },
      messages: messages ?? thread.messages,
    }

    this.persistThread(updated)
    this.threadCache.set(id, updated)
    return updated
  }

  /**
   * Archive a thread (soft delete).
   */
  archiveThread(id: string): StoredThread | null {
    const thread = this.readThread(id)
    if (!thread) return null

    return this.updateThread(id, {
      status: ThreadStatus.Archived,
      archivedAt: Date.now(),
    })
  }

  /**
   * Unarchive a thread.
   */
  unarchiveThread(id: string): StoredThread | null {
    const thread = this.readThread(id)
    if (!thread) return null

    return this.updateThread(id, {
      status: ThreadStatus.Active,
      archivedAt: undefined,
    })
  }

  /**
   * Delete a thread permanently.
   */
  deleteThread(id: string): boolean {
    const entryPath = this.getEntryPath(id)
    if (existsSync(entryPath)) {
      try {
        unlinkSync(entryPath)
        this.threadCache.delete(id)
        return true
      } catch {
        return false
      }
    }
    return false
  }

  /**
   * Fork a thread into a new thread.
   */
  forkThread(id: string, newId: string, model?: string): StoredThread | null {
    // Reject a traversal-shaped target up front (#68) — validating only at
    // persist time would let a missing source id hide the bad newId.
    this.assertSafeThreadId(newId)
    const thread = this.readThread(id)
    if (!thread) return null

    const now = Date.now()
    const forked: StoredThread = {
      metadata: {
        id: newId,
        source: ThreadSource.Fork,
        status: ThreadStatus.Active,
        createdAt: now,
        updatedAt: now,
        forkedFrom: id,
        parentThreadId: id,
        model: thread.metadata.model ?? model,
      },
      messages: [...thread.messages],
    }

    this.persistThread(forked)
    this.threadCache.set(newId, forked)
    return forked
  }

  /**
   * Resume a thread from archived state.
   */
  resumeThread(id: string): StoredThread | null {
    return this.unarchiveThread(id)
  }

  /**
   * Migrate a thread to a new store location.
   */
  migrateThread(id: string, newStoreDir: string): boolean {
    const thread = this.readThread(id)
    if (!thread) return false

    const entryPath = this.getEntryPath(id)
    const newPath = join(newStoreDir, `${id}.json`)

    try {
      if (existsSync(entryPath)) {
        const data = readFileSync(entryPath, "utf8")
        mkdirSync(dirname(newPath), { recursive: true })
        writeFileSync(newPath, data, { encoding: "utf8" })

        // Update metadata
        this.updateThread(id, {
          status: ThreadStatus.Migrated,
          migratedAt: Date.now(),
        })
        return true
      }
    } catch {
      return false
    }
    return false
  }

  /**
   * Add messages to a thread.
   */
  addMessages(id: string, messages: StoredMessage[]): StoredThread | null {
    const thread = this.readThread(id)
    if (!thread) return null

    return this.updateThread(id, {}, [...thread.messages, ...messages])
  }

  /**
   * Get all active threads.
   */
  getActiveThreads(): StoredThread[] {
    return this.getAllThreads().filter((t) => t.metadata.status === ThreadStatus.Active)
  }

  /**
   * Get all threads (including archived).
   */
  getAllThreads(): StoredThread[] {
    const threads: StoredThread[] = []
    for (const file of this.listFiles()) {
      const thread = this.readThread(file)
      if (thread) threads.push(thread)
    }
    return threads.sort((a, b) => b.metadata.updatedAt - a.metadata.updatedAt)
  }

  /**
   * Get thread count.
   */
  getThreadCount(): number {
    return this.listFiles().length
  }

  /**
   * Search threads by query.
   */
  searchThreads(query: string): StoredThread[] {
    const q = query.toLowerCase()
    return this.getAllThreads().filter((t) => JSON.stringify(t).toLowerCase().includes(q))
  }

  /**
   * Close the store: drop the cache without rewriting it. Every mutation
   * already persisted at call time — re-persisting here would clobber
   * threads another process updated since we cached them (#69).
   */
  close(): void {
    this.threadCache.clear()
  }

  /**
   * Clear all threads (useful for testing).
   */
  clear(): void {
    const files = this.listFiles()
    for (const file of files) {
      try {
        unlinkSync(this.getEntryPath(file))
      } catch {
        /* ignore */
      }
    }
    this.threadCache.clear()
  }

  // --- Internal methods ---

  private assertSafeThreadId(id: string): void {
    if (!SAFE_THREAD_ID.test(id)) {
      throw new Error(
        `Invalid thread id "${id}" — ids may contain only letters, digits, ".", "_", "-" and must start with a letter or digit.`,
      )
    }
  }

  private getEntryPath(id: string): string {
    this.assertSafeThreadId(id)
    return join(this.storeDir, `${id}.json`)
  }

  private readEntry(id: string): ThreadStoreEntry | null {
    const path = this.getEntryPath(id)
    if (!existsSync(path)) return null
    let raw: string
    try {
      raw = readFileSync(path, "utf8")
    } catch {
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.quarantineCorrupt(path)
      return null
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.quarantineCorrupt(path)
      return null
    }
    const entry = parsed as ThreadStoreEntry
    if (!entry.metadata || typeof entry.metadata !== "object" || !Array.isArray(entry.messages)) {
      this.quarantineCorrupt(path)
      return null
    }
    // The stored checksum proves the messages survived intact (#69): verify
    // when present. Entries without one (legacy) keep parse-and-trust — a
    // stricter rule would quarantine every pre-checksum thread on upgrade.
    if (typeof entry.checksum === "string" && entry.checksum.startsWith("checksum_")) {
      if (entry.checksum !== this.computeChecksum(entry.messages)) {
        this.quarantineCorrupt(path)
        return null
      }
    }
    return entry
  }

  /** Move an unreadable entry aside with its bytes intact (#69) — the
   *  next `createThread` with the same id must never overwrite evidence. */
  private quarantineCorrupt(path: string): void {
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`)
    } catch {
      /* best-effort: an OS refusal leaves the corrupt file in place */
    }
  }

  private persistThread(thread: StoredThread): void {
    const path = this.getEntryPath(thread.metadata.id)
    const entry: ThreadStoreEntry = {
      metadata: thread.metadata,
      messages: thread.messages,
      checksum: this.computeChecksum(thread.messages),
    }
    mkdirSync(dirname(path), { recursive: true })
    const json = JSON.stringify(entry)
    // tmp + rename: a crash mid-write can never leave a half-written entry
    // for readEntry to quarantine (#69). Retry before the direct-write
    // fallback (Windows EPERM while the destination is held open).
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, json, { encoding: "utf8" })
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        renameSync(tmp, path)
        return
      } catch {
        /* retry, then fall through */
      }
    }
    try {
      writeFileSync(path, json, { encoding: "utf8" })
    } finally {
      try {
        unlinkSync(tmp)
      } catch {
        /* tmp already renamed or gone */
      }
    }
  }

  private computeChecksum(messages: StoredMessage[]): string {
    // Formula unchanged on purpose: entries written by older versions
    // verify against it — altering it would quarantine every existing
    // thread as "corrupt" on upgrade.
    const data = JSON.stringify({ messages })
    let hash = 0
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash |= 0
    }
    return `checksum_${Math.abs(hash).toString(36)}`
  }

  /**
   * List thread IDs in the store.
   *
   * Returns bare IDs (without the `.json` suffix) because every caller —
   * `readThread(id)`, `getEntryPath(id)`, `clear()` — appends the extension
   * itself. Reading the store *directory* as a file (the previous
   * implementation) always threw EISDIR, so count/list/search silently
   * returned empty results.
   */
  private listFiles(): string[] {
    try {
      return (
        readdirSync(this.storeDir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.slice(0, -".json".length))
          // Strays that fail the id rule were never written by this store —
          // skip them instead of letting getEntryPath throw during listing (#68).
          .filter((id) => SAFE_THREAD_ID.test(id))
      )
    } catch {
      return []
    }
  }
}

/** Get the singleton ThreadStore. */
export function getThreadStore(storeDir?: string): ThreadStore {
  return ThreadStore.getInstance(storeDir)
}

/** Reset the singleton to a fresh store. Tests only. */
export function resetThreadStore(storeDir?: string): ThreadStore {
  return ThreadStore.resetInstance(storeDir)
}

/**
 * Create a new thread in the store.
 */
export function createThread(
  id: string,
  source: ThreadSource,
  status?: ThreadStatus,
  model?: string,
  parentThreadId?: string,
): StoredThread {
  const store = getThreadStore()
  return store.createThread(id, { source, status: status ?? ThreadStatus.Active, model, parentThreadId })
}

/**
 * Archive a thread by ID.
 */
export function archiveThread(id: string): StoredThread | null {
  return getThreadStore().archiveThread(id)
}

/**
 * Fork a thread into a new thread.
 */
export function forkThread(id: string, newId: string, model?: string): StoredThread | null {
  return getThreadStore().forkThread(id, newId, model)
}
