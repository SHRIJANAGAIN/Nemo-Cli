/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Session Store — persistent thread storage with fork, archive, resume, unarchive, delete, migrate.
 *
 * Mirrors codex-thread-store in Rust (codex_thread_store crate).
 * Provides full lifecycle management of conversation threads.
 */

import { join, dirname } from "path"
import { homedir } from "os"
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "fs"

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
    return this.threadCache.size
  }

  /**
   * Search threads by query.
   */
  searchThreads(query: string): StoredThread[] {
    const q = query.toLowerCase()
    return this.getAllThreads().filter((t) => JSON.stringify(t).toLowerCase().includes(q))
  }

  /**
   * Close the store and persist all cached threads.
   */
  close(): void {
    for (const thread of this.threadCache.values()) {
      this.persistThread(thread)
    }
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

  private getEntryPath(id: string): string {
    return join(this.storeDir, `${id}.json`)
  }

  private readEntry(id: string): ThreadStoreEntry | null {
    const path = this.getEntryPath(id)
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, "utf8")) as ThreadStoreEntry
    } catch {
      return null
    }
  }

  private persistThread(thread: StoredThread): void {
    const path = this.getEntryPath(thread.metadata.id)
    const entry: ThreadStoreEntry = {
      metadata: thread.metadata,
      messages: thread.messages,
      checksum: this.computeChecksum(thread),
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(entry), { encoding: "utf8" })
  }

  private computeChecksum(thread: StoredThread): string {
    const data = JSON.stringify({ messages: thread.messages })
    let hash = 0
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash |= 0
    }
    return `checksum_${Math.abs(hash).toString(36)}`
  }

  private listFiles(): string[] {
    if (!existsSync(this.storeDir)) return []
    try {
      return readdirSync(this.storeDir).filter((f) => f.endsWith(".json"))
    } catch {
      return []
    }
  }
}

/** Get the singleton ThreadStore. */
export function getThreadStore(storeDir?: string): ThreadStore {
  return ThreadStore.getInstance(storeDir)
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
