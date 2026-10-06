/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Workspace checkpoints with undo/redo (ported from SKT AI LABS Code's snapshot
 * system, adapted to work without requiring a git repository).
 *
 * Layout under `<cwd>/.trayambak/checkpoints/`:
 *   objects/<sha256>   content-addressed file blobs (shared across points)
 *   cp-0001/manifest.json   one manifest per checkpoint
 *   stacks.json              persisted undo/redo stacks (survives restarts)
 *
 * capture() is called before every agent turn; undo() restores the previous
 * point (remembering the current state for redo()), redo() re-applies it.
 * Files created after a checkpoint are deleted on restore, files deleted
 * after it are brought back — a full workspace time machine.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as crypto from "crypto"

/** Directories never captured (and never deleted on restore). */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".trayambak",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".next",
  ".nuxt",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
])

/** Files larger than this are recorded as "present but untracked" (null). */
const MAX_FILE_BYTES = 5 * 1024 * 1024

/** Hard ceilings per snapshot: without these a home-directory cwd walks
 *  700k+ files and reads GBs into RAM (observed: 25GB of blobs + OOM).
 *  Oversize workspaces skip capture entirely (undo keeps working off the
 *  previous point) instead of recording a corrupt partial manifest. */
const MAX_CAPTURE_FILES = 5000
const MAX_CAPTURE_BYTES = 50 * 1024 * 1024
/** Manifests bigger than this are never parsed (a home-tree manifest is
 *  ~100MB of JSON — reading it alone can OOM a listing). */
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024

export class CheckpointTooBigError extends Error {
  readonly fileCount: number
  readonly byteCount: number
  constructor(fileCount: number, byteCount: number) {
    super(
      `workspace too large for checkpoints (${fileCount.toLocaleString()} files, ${(byteCount / 1048576).toFixed(0)}MB scanned; cap ${MAX_CAPTURE_FILES.toLocaleString()} files / 50MB) — skipped`,
    )
    this.name = "CheckpointTooBigError"
    this.fileCount = fileCount
    this.byteCount = byteCount
  }
}

/** Home dir / filesystem root as a workspace means "snapshot everything":
 *  never capture there (undo/redo report why instead of OOMing). */
export function isUnsafeWorkspaceDir(cwd: string): boolean {
  const resolved = path.resolve(cwd)
  const home = path.resolve(os.homedir())
  if (resolved === home) return true
  return resolved === path.parse(resolved).root
}

export interface CheckpointMeta {
  id: string
  label: string
  createdAt: number
  fileCount: number
  stateHash: string
}

interface CheckpointManifest {
  id: string
  label: string
  createdAt: number
  /** relPath (forward slashes) → sha256 of content, or null when untracked. */
  files: Record<string, string | null>
  /** relPath → { s: byte size, m: mtimeMs } at hash time. Powers the stat
   *  cache: an unchanged size+mtime reuses the recorded hash WITHOUT
   *  re-reading the file, so repeat captures on a quiet workspace cost a
   *  walk + stats instead of a full re-hash (measured 4.8s → ~0.3s on the
   *  trayambak repo). Absent on pre-cache manifests — those entries are
   *  simply re-hashed once, then recorded. Same mtime+size assumption as
   *  git's racy-clean logic; a missed sub-tick rewrite only affects which
   *  undo point a file restores to, never correctness of the restore. */
  stats?: Record<string, { s: number; m: number }>
  stateHash: string
  fileCount: number
}

export type CheckpointResult = { ok: true; restored: CheckpointMeta; message: string } | { ok: false; reason: string }

interface Stacks {
  undo: string[]
  redo: string[]
}

function sha256(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex")
}

/** Best-effort recursive byte total (symlinks skipped, errors ignored). */
function dirSizeSync(dir: string): number {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    try {
      if (e.isDirectory()) total += dirSizeSync(full)
      else if (e.isFile()) total += fs.statSync(full).size
    } catch {
      /* ignore */
    }
  }
  return total
}

export class CheckpointStore {
  private readonly cwd: string
  private readonly root: string
  private readonly objectsDir: string
  private readonly max: number
  private counter = 0
  private undoStack: string[] = []
  private redoStack: string[] = []

  constructor(cwd: string, opts?: { maxCheckpoints?: number }) {
    this.cwd = path.resolve(cwd)
    this.root = path.join(this.cwd, ".trayambak", "checkpoints")
    this.objectsDir = path.join(this.root, "objects")
    this.max = Math.max(2, opts?.maxCheckpoints ?? 20)
    this.disabled = isUnsafeWorkspaceDir(this.cwd)
    if (!this.disabled) {
      fs.mkdirSync(this.objectsDir, { recursive: true })
    }
    this.loadState()
    this.hydrateStatCache()
  }

  /** True when captures are refused (home/root cwd) — see disabledReason. */
  readonly disabled: boolean

  /**
   * relPath → last hashed stat. A stat match (size + mtimeMs) reuses the
   * recorded hash without touching file contents. Seeded from the newest
   * manifest on construction so the FIRST capture after a restart also
   * benefits. A cache hit whose blob was GC'd is still valid — the next
   * capture re-copies the blob from the working file (stat still matches,
   * so no re-hash is needed either).
   */
  private readonly statCache = new Map<string, { hash: string | null; size: number; mtimeMs: number }>()

  private hydrateStatCache(): void {
    if (this.disabled) return
    try {
      const lastId = this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1] : undefined
      const ids = lastId !== undefined ? [lastId] : this.listIds().slice(-1)
      if (ids.length === 0) return
      const manifest = this.readManifest(ids[0])
      const stats = manifest?.stats
      if (!stats) return
      for (const [rel, hash] of Object.entries(manifest.files)) {
        const st = stats[rel]
        if (!st) continue
        this.statCache.set(rel, { hash, size: st.s, mtimeMs: st.m })
      }
    } catch {
      /* best effort — a missing cache only costs one full re-hash */
    }
  }

  disabledReason(): string {
    return `checkpoints off: "${this.cwd}" is a home directory or filesystem root — snapshotting it would copy your whole machine (observed: 25GB). cd into a project folder instead.`
  }

  isDisabled(): boolean {
    return this.disabled
  }

  /* ───────────────────────────── public API ───────────────────────────── */

  /**
   * Snapshot the current workspace and push it on the undo stack.
   * Called before each agent turn. Invalidates the redo stack (new work
   * branches away from undone history).
   */
  capture(label: string): CheckpointMeta {
    if (this.disabled) return { id: "", label, createdAt: Date.now(), fileCount: 0, stateHash: "" }
    const meta = this.snapshot(label)
    this.recordCapture(meta)
    return meta
  }

  /**
   * Async variant of capture() for the per-turn path: fully ASYNCHRONOUS I/O
   * (fs.promises) plus a wall-clock budget, so snapshotting can neither
   * freeze the TUI nor delay the turn for long.
   *
   * The previous implementation drove the SYNC generator with setImmediate
   * yields — but the generator body itself was synchronous: the whole
   * workspace walk and every statSync/readFileSync/copyFileSync ran in
   * unbroken blocks between yields. On a OneDrive-synced cwd a single
   * readFileSync against a cloud-only file blocks the event loop for the
   * entire network hydration: the spinner froze on the first frame (⠋), the
   * cursor blinked at a stale mid-frame position, Tokens stayed 0, and the
   * turn looked dead — exactly what setImmediate yields cannot prevent.
   *
   * Async reads yield naturally around every hydration wait, so the UI keeps
   * repainting throughout. The budget (default 15s) bounds turn latency: on
   * expiry the snapshot is ABANDONED whole — no partial manifest, no stack
   * change, undo simply keeps the previous point — and the turn runs.
   */
  async captureAsync(label: string, opts?: { budgetMs?: number }): Promise<CheckpointMeta> {
    const budgetMs = opts?.budgetMs ?? 15_000
    if (this.disabled) return { id: "", label, createdAt: Date.now(), fileCount: 0, stateHash: "" }
    const started = Date.now()
    const budgetError = new Error(
      `checkpoint capture exceeded its ${budgetMs}ms budget — skipped (undo keeps the previous point)`,
    )
    const expired = (): boolean => Date.now() - started > budgetMs

    await fs.promises.mkdir(this.objectsDir, { recursive: true })

    const entries = await this.walkAsync(expired, budgetError)
    const files: Record<string, string | null> = {}
    const stats: Record<string, { s: number; m: number }> = {}
    const lines: string[] = []
    let bytesRead = 0

    for (const { rel, abs } of entries) {
      try {
        const sized = await this.hashFileCachedAsync(abs, rel)
        if (sized.hash === null) {
          files[rel] = null // present but untracked (too large)
          stats[rel] = { s: sized.size, m: sized.mtimeMs }
          continue
        }
        bytesRead += sized.size
        if (bytesRead > MAX_CAPTURE_BYTES) throw new CheckpointTooBigError(entries.length, bytesRead)
        stats[rel] = { s: sized.size, m: sized.mtimeMs }
        // Cache hit + GC'd blob: re-copy from the working file (stat still
        // matches, so the content is the recorded hash — no re-read needed).
        if (!(await this.ensureBlobAsync(abs, sized.hash))) {
          files[rel] = null
          continue
        }
        files[rel] = sized.hash
        lines.push(`${rel}:${sized.hash}`)
      } catch {
        continue // vanished mid-walk / unreadable
      }
      if (expired()) throw budgetError
    }

    const meta = this.finalizeSnapshot(label, files, lines, stats)
    await this.recordCaptureAsync(meta)
    return meta
  }

  private recordCapture(meta: CheckpointMeta): void {
    this.undoStack.push(meta.id)
    this.trim(this.undoStack)
    this.redoStack = []
    this.saveState()
    this.gcObjects()
  }

  /** Async twin of recordCapture: identical stack bookkeeping, but the
   *  object GC reads manifests with fs.promises — they can be MBs and live
   *  under a cloud-synced cwd, where a sync read hydrates and freezes. */
  private async recordCaptureAsync(meta: CheckpointMeta): Promise<void> {
    this.undoStack.push(meta.id)
    this.trim(this.undoStack)
    this.redoStack = []
    this.saveState()
    await this.gcObjectsAsync()
  }

  /** Restore the previous checkpoint; current state is kept for redo. */
  undo(): CheckpointResult {
    if (this.disabled) {
      return { ok: false, reason: this.disabledReason() }
    }
    if (this.undoStack.length === 0) {
      return { ok: false, reason: "no earlier checkpoint (nothing to undo yet)" }
    }
    const targetId = this.undoStack[this.undoStack.length - 1]
    const target = this.readManifest(targetId)
    if (!target) {
      this.undoStack.pop()
      this.saveState()
      return { ok: false, reason: "checkpoint manifest missing or too large to read" }
    }

    // Remember the state we are leaving (redo point), unless it already
    // matches the target — then undo is a no-op for the file system.
    // Oversize workspaces skip the redo point (redo just stays empty).
    let current: CheckpointMeta | null = null
    try {
      current = this.snapshot(`undo-point → ${target.id}`)
    } catch (err) {
      if (!(err instanceof CheckpointTooBigError)) throw err
    }
    if (current && current.stateHash === target.stateHash) {
      this.deleteCheckpoint(current.id)
      this.undoStack.pop()
      this.saveState()
      return { ok: true, restored: target, message: `Already at checkpoint ${target.id} (${target.label})` }
    }

    if (current) {
      this.redoStack.push(current.id)
      this.trim(this.redoStack)
    }
    this.undoStack.pop()
    this.saveState()
    this.restore(target)
    return {
      ok: true,
      restored: target,
      message: `↩ Restored checkpoint ${target.id} (${target.label}) — ${target.fileCount} files`,
    }
  }

  /** Re-apply the state that the last undo abandoned. */
  redo(): CheckpointResult {
    if (this.disabled) {
      return { ok: false, reason: this.disabledReason() }
    }
    if (this.redoStack.length === 0) {
      return { ok: false, reason: "nothing to redo" }
    }
    const targetId = this.redoStack[this.redoStack.length - 1]
    const target = this.readManifest(targetId)
    if (!target) {
      this.redoStack.pop()
      this.saveState()
      return { ok: false, reason: "checkpoint manifest missing or too large to read" }
    }

    let current: CheckpointMeta | null = null
    try {
      current = this.snapshot(`redo-point → ${target.id}`)
    } catch (err) {
      if (!(err instanceof CheckpointTooBigError)) throw err
    }
    if (current && current.stateHash === target.stateHash) {
      this.deleteCheckpoint(current.id)
      this.redoStack.pop()
      this.saveState()
      return { ok: true, restored: target, message: `Already at checkpoint ${target.id} (${target.label})` }
    }

    if (current) {
      this.undoStack.push(current.id)
      this.trim(this.undoStack)
    }
    this.redoStack.pop()
    this.saveState()
    this.restore(target)
    return {
      ok: true,
      restored: target,
      message: `↪ Redone checkpoint ${target.id} (${target.label}) — ${target.fileCount} files`,
    }
  }

  /** All checkpoints, oldest first. */
  list(): CheckpointMeta[] {
    return this.listIds()
      .map((id) => this.readManifest(id))
      .filter((m): m is CheckpointManifest => m !== null)
      .map((m) => ({
        id: m.id,
        label: m.label,
        createdAt: m.createdAt,
        fileCount: m.fileCount,
        stateHash: m.stateHash,
      }))
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /* ─────────────────────────── file walking ─────────────────────────── */

  private walk(cap = MAX_CAPTURE_FILES): Array<{ rel: string; abs: string }> {
    const out: Array<{ rel: string; abs: string }> = []
    const stack: string[] = [this.cwd]
    while (stack.length > 0) {
      const dir = stack.pop()!
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        this.classifyEntry(entry, path.join(dir, entry.name), out, stack)
        // Snapshot walks stop past the cap (callers treat overflow as
        // too-big and abandon the snapshot); restore() passes Infinity.
        if (out.length > cap) throw new CheckpointTooBigError(out.length, 0)
      }
    }
    return out
  }

  /** Shared directory-entry classification for the sync walk() and the
   *  per-turn walkAsync() — one filter implementation, no drift. */
  private classifyEntry(
    entry: fs.Dirent,
    abs: string,
    out: Array<{ rel: string; abs: string }>,
    stack: string[],
  ): void {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) return
      stack.push(abs)
    } else if (entry.isFile()) {
      const rel = path.relative(this.cwd, abs).split(path.sep).join("/")
      out.push({ rel, abs })
    }
    // symlinks and special files are intentionally skipped
  }

  /** Async twin of walk(): every directory list is awaited, so the event
   *  loop keeps turning through the traversal — a sync readdirSync over a
   *  cloud-synced tree can stall for just as long as a hydrating read. The
   *  capture budget is checked per directory. */
  private async walkAsync(expired: () => boolean, budgetError: Error): Promise<Array<{ rel: string; abs: string }>> {
    const out: Array<{ rel: string; abs: string }> = []
    const stack: string[] = [this.cwd]
    while (stack.length > 0) {
      if (expired()) throw budgetError
      const dir = stack.pop()!
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        this.classifyEntry(entry, path.join(dir, entry.name), out, stack)
        if (out.length > MAX_CAPTURE_FILES) throw new CheckpointTooBigError(out.length, 0)
      }
    }
    return out
  }

  /**
   * Sync cached hash: a stat-cache hit returns WITHOUT reading the file.
   * Throws on missing/unreadable files exactly like a direct stat+read, so
   * existing try/catch call sites behave identically.
   */
  private hashFileCached(abs: string, rel: string): { hash: string | null; size: number; mtimeMs: number } {
    const stat = fs.statSync(abs)
    const size = stat.size
    const mtimeMs = stat.mtimeMs
    if (size > MAX_FILE_BYTES) {
      const out = { hash: null as string | null, size, mtimeMs }
      this.statCache.set(rel, { ...out })
      return out
    }
    const hit = this.statCache.get(rel)
    if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return { ...hit }
    const out = { hash: sha256(fs.readFileSync(abs)) as string | null, size, mtimeMs }
    this.statCache.set(rel, { ...out })
    return out
  }

  /**
   * Async twin of hashFileCached for the per-turn captureAsync() path:
   * every stat/read is awaited so the event loop keeps turning.
   */
  private async hashFileCachedAsync(
    abs: string,
    rel: string,
  ): Promise<{ hash: string | null; size: number; mtimeMs: number }> {
    const stat = await fs.promises.stat(abs)
    const size = stat.size
    const mtimeMs = stat.mtimeMs
    if (size > MAX_FILE_BYTES) {
      const out = { hash: null as string | null, size, mtimeMs }
      this.statCache.set(rel, { ...out })
      return out
    }
    const hit = this.statCache.get(rel)
    if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return { ...hit }
    const out = { hash: sha256(await fs.promises.readFile(abs)) as string | null, size, mtimeMs }
    this.statCache.set(rel, { ...out })
    return out
  }

  /**
   * Ensure the content blob for a hash exists, copying from the working file
   * when the stat cache spared us the re-hash but GC dropped the blob.
   * Returns null when the file must be recorded as untracked (copy failed).
   */
  private async ensureBlobAsync(abs: string, hash: string): Promise<boolean> {
    const objPath = path.join(this.objectsDir, hash)
    if (fs.existsSync(objPath)) return true
    try {
      await fs.promises.copyFile(abs, objPath)
      return true
    } catch {
      return false
    }
  }

  /* ────────────────────────── snapshot/restore ────────────────────────── */

  /**
   * Snapshot as a generator for the SYNC path (capture() — used by
   * undo/redo's pre-restore points): the caller drains it in one go. The
   * per-turn async path (captureAsync) mirrors this walk/hash logic with
   * fs.promises and shares the manifest write via finalizeSnapshot(), so
   * both paths produce byte-identical checkpoints.
   */
  private *snapshotSteps(label: string): Generator<void, CheckpointMeta, void> {
    fs.mkdirSync(this.objectsDir, { recursive: true })
    const files: Record<string, string | null> = {}
    const stats: Record<string, { s: number; m: number }> = {}
    const lines: string[] = []
    const entries = this.walk()

    let bytesRead = 0
    for (let i = 0; i < entries.length; i++) {
      const { rel, abs } = entries[i]
      let sized: { hash: string | null; size: number; mtimeMs: number } | null
      try {
        sized = this.hashFileCached(abs, rel)
      } catch {
        continue // vanished mid-walk / unreadable
      }
      const hash = sized.hash
      bytesRead += sized.size
      if (bytesRead > MAX_CAPTURE_BYTES) throw new CheckpointTooBigError(entries.length, bytesRead)
      stats[rel] = { s: sized.size, m: sized.mtimeMs }
      if (hash === null) {
        files[rel] = null // present but untracked (too large)
        continue
      }
      const objPath = path.join(this.objectsDir, hash)
      if (!fs.existsSync(objPath)) {
        try {
          fs.copyFileSync(abs, objPath)
        } catch {
          files[rel] = null
          continue
        }
      }
      files[rel] = hash
      lines.push(`${rel}:${hash}`)
      if ((i & 63) === 63) {
        yield // the consumer decides whether to give the event loop a turn
      }
    }

    return this.finalizeSnapshot(label, files, lines, stats)
  }

  /** Shared manifest write for the sync snapshotSteps() drain and the async
   *  captureAsync() path — identical ids, stateHash, and manifest bytes. */
  private finalizeSnapshot(
    label: string,
    files: Record<string, string | null>,
    lines: string[],
    stats: Record<string, { s: number; m: number }>,
  ): CheckpointMeta {
    lines.sort()
    const stateHash = sha256(lines.join("\n"))
    this.counter += 1
    const id = String(this.counter).padStart(4, "0")
    const manifest: CheckpointManifest = {
      id,
      label,
      createdAt: Date.now(),
      files,
      stats,
      stateHash,
      fileCount: Object.keys(files).length,
    }
    const dir = path.join(this.root, `cp-${id}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest))
    return { id, label, createdAt: manifest.createdAt, fileCount: manifest.fileCount, stateHash }
  }

  private snapshot(label: string): CheckpointMeta {
    const steps = this.snapshotSteps(label)
    let step = steps.next()
    while (!step.done) step = steps.next()
    return step.value
  }

  private restore(manifest: CheckpointManifest): void {
    // 1) Delete files that exist now but were not present (nor untracked)
    //    at checkpoint time — these were created after the snapshot.
    //    Uncapped walk: halving this scan would strand new files behind.
    for (const { rel, abs } of this.walk(Infinity)) {
      if (!(rel in manifest.files)) {
        try {
          fs.rmSync(abs, { force: true })
          this.pruneEmptyDirs(path.dirname(abs))
        } catch {
          /* best effort */
        }
      }
    }

    // 2) Write back every tracked file (skip unchanged ones for speed).
    for (const [rel, hash] of Object.entries(manifest.files)) {
      if (hash === null) continue // untracked → leave whatever is there
      const abs = path.join(this.cwd, rel.split("/").join(path.sep))
      try {
        if (fs.existsSync(abs) && this.hashFileCached(abs, rel).hash === hash) continue
        const objPath = path.join(this.objectsDir, hash)
        if (!fs.existsSync(objPath)) continue // object GC'd — nothing to do
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.copyFileSync(objPath, abs)
      } catch {
        /* best effort per file */
      }
    }
  }

  private pruneEmptyDirs(startDir: string): void {
    let dir = startDir
    while (dir.startsWith(this.cwd + path.sep) && dir !== this.cwd) {
      try {
        if (fs.readdirSync(dir).length > 0) break
        fs.rmdirSync(dir)
      } catch {
        break
      }
      dir = path.dirname(dir)
    }
  }

  /* ──────────────────────────── bookkeeping ──────────────────────────── */

  private listIds(): string[] {
    try {
      return fs
        .readdirSync(this.root)
        .filter((name) => name.startsWith("cp-"))
        .map((name) => name.slice(3))
        .sort()
    } catch {
      return []
    }
  }

  private readManifest(id: string): CheckpointManifest | null {
    try {
      const manifestPath = path.join(this.root, `cp-${id}`, "manifest.json")
      // A home-tree manifest is ~100MB of JSON — stat first, never parse
      // monsters into the heap (listing/undo/GC all funnel through here).
      const stat = fs.statSync(manifestPath)
      if (stat.size > MAX_MANIFEST_BYTES) return null
      const raw = fs.readFileSync(manifestPath, "utf8")
      return JSON.parse(raw) as CheckpointManifest
    } catch {
      return null
    }
  }

  /** Delete every checkpoint (manifests + blobs + stacks) and report the
   *  reclaimed bytes. Escape hatch for runaway stores (e.g. a home-dir
   *  workspace that snapshotted the whole machine before the guards). */
  prune(): { removed: number; bytes: number } {
    let removed = 0
    let bytes = 0
    try {
      for (const id of this.listIds()) {
        const dir = path.join(this.root, `cp-${id}`)
        bytes += dirSizeSync(dir)
        fs.rmSync(dir, { recursive: true, force: true })
        removed++
      }
      bytes += dirSizeSync(this.objectsDir)
      fs.rmSync(this.objectsDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    this.counter = 0
    this.undoStack = []
    this.redoStack = []
    this.saveState()
    return { removed, bytes }
  }

  private deleteCheckpoint(id: string): void {
    try {
      fs.rmSync(path.join(this.root, `cp-${id}`), { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }

  private trim(stack: string[]): void {
    while (stack.length > this.max) {
      const id = stack.shift()
      if (id !== undefined) this.deleteCheckpoint(id)
    }
  }

  private get stacksFile(): string {
    return path.join(this.root, "stacks.json")
  }

  private loadState(): void {
    const ids = this.listIds()
    this.counter = ids.length > 0 ? Number(ids[ids.length - 1]) || 0 : 0
    try {
      const raw = fs.readFileSync(this.stacksFile, "utf8")
      const parsed = JSON.parse(raw) as Stacks
      const known = new Set(ids)
      this.undoStack = (parsed.undo ?? []).filter((id) => known.has(id))
      this.redoStack = (parsed.redo ?? []).filter((id) => known.has(id))
    } catch {
      this.undoStack = []
      this.redoStack = []
    }
  }

  private saveState(): void {
    try {
      const stacks: Stacks = { undo: this.undoStack, redo: this.redoStack }
      fs.writeFileSync(this.stacksFile, JSON.stringify(stacks))
    } catch {
      /* best effort */
    }
  }

  /** Drop objects no manifest references anymore. */
  private gcObjects(): void {
    try {
      const referenced = new Set<string>()
      for (const id of this.listIds()) {
        const manifest = this.readManifest(id)
        if (!manifest) continue
        for (const hash of Object.values(manifest.files)) {
          if (hash) referenced.add(hash)
        }
      }
      for (const name of fs.readdirSync(this.objectsDir)) {
        if (!referenced.has(name)) {
          try {
            fs.rmSync(path.join(this.objectsDir, name), { force: true })
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* GC must never break capture */
    }
  }

  /** Async twin of gcObjects(): manifests are read with fs.promises — they
   *  can be MBs and live under a cloud-synced cwd, where a sync read blocks
   *  the event loop for the whole hydration. */
  private async gcObjectsAsync(): Promise<void> {
    try {
      const referenced = new Set<string>()
      for (const id of this.listIds()) {
        let manifest: CheckpointManifest | null = null
        try {
          const raw = await fs.promises.readFile(path.join(this.root, `cp-${id}`, "manifest.json"), "utf8")
          manifest = JSON.parse(raw) as CheckpointManifest
        } catch {
          manifest = null
        }
        if (!manifest) continue
        for (const hash of Object.values(manifest.files)) {
          if (hash) referenced.add(hash)
        }
      }
      for (const name of await fs.promises.readdir(this.objectsDir)) {
        if (referenced.has(name)) continue
        try {
          await fs.promises.rm(path.join(this.objectsDir, name), { force: true })
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* GC must never break capture */
    }
  }
}
