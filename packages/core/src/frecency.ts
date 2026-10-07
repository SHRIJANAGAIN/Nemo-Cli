/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * Frecency ranking for file mentions.
 *
 * Sorting `@` suggestions by pure recency is a trap: the file you opened forty
 * times last week is the file you mean, but it loses to whatever you touched
 * this morning. Sorting by pure frequency is the same trap inverted — one ancient
 * hot file permanently occupies the top slot.
 *
 * Frecency scores frequency against age:
 *
 *     score = opens / (1 + ageDays)
 *
 * which is why both signals are needed: 100 opens a year ago scores 0.27, two
 * opens this morning score 2.0, so a working set stays on top while a burst of
 * one-off opens still climbs.
 *
 * `ageDays` is capped so a stale-but-real entry cannot divide itself into
 * irrelevance — dropping the cap makes the sort a pure recency list again.
 */

const DAY_MS = 86_400_000

/** Beyond this age every entry is treated as equally old; see above. */
export const MAX_AGE_DAYS = 90

/** Entries retained; older/weaker ones are pruned so the store cannot grow forever. */
export const MAX_ENTRIES = 500

/** Store format version — bumped when the record shape changes. */
export const FRECENCY_VERSION = 1

/**
 * Two opens inside this window are one open.
 *
 * Without it, a `@`-autocomplete that opens a file on every keystroke would mint
 * hundreds of "opens" for a single visit and freeze the file at the top forever.
 */
export const OPENS_DEDUPE_MS = 60_000

/** One row of the store. */
export interface FrecencyEntry {
  readonly path: string
  readonly opens: number
  /** Epoch ms of the most recent counted open. */
  readonly lastOpened: number
}

/** Tuning knobs, all optional. */
export interface FrecencyOptions {
  readonly now?: number
  readonly maxAgeDays?: number
  /** Restrict to entries whose path satisfies this (case-insensitive substring). */
  readonly filter?: string
  readonly limit?: number
}

/**
 * Rank one entry.
 *
 * Never-opened and impossible timestamps score 0 instead of throwing or going
 * NaN: a corrupt store must not be able to poison a sort comparator, because a
 * NaN there silently reorders the entire list.
 */
export function frecencyScore(entry: FrecencyEntry, now: number = Date.now(), maxAgeDays = MAX_AGE_DAYS): number {
  if (entry.opens <= 0 || !Number.isFinite(entry.lastOpened) || entry.lastOpened <= 0) return 0
  const ageDays = Math.min(maxAgeDays, Math.max(0, now - entry.lastOpened) / DAY_MS)
  return entry.opens / (1 + ageDays)
}

/**
 * Rank entries best-first.
 *
 * Ties break on recency then alphabetically so the order is total and stable —
 * without that, two equally-relevant files swap places between keystrokes and the
 * list appears to flicker.
 */
export function rankByFrecency(entries: readonly FrecencyEntry[], options: FrecencyOptions = {}): FrecencyEntry[] {
  const now = options.now ?? Date.now()
  const maxAge = options.maxAgeDays ?? MAX_AGE_DAYS
  const needle = options.filter?.trim().toLowerCase()
  const pool = needle ? entries.filter((e) => e.path.toLowerCase().includes(needle)) : [...entries]
  pool.sort((a, b) => {
    const delta = frecencyScore(b, now, maxAge) - frecencyScore(a, now, maxAge)
    if (delta !== 0) return delta
    if (b.lastOpened !== a.lastOpened) return b.lastOpened - a.lastOpened
    return a.path.localeCompare(b.path)
  })
  return options.limit !== undefined ? pool.slice(0, Math.max(0, options.limit)) : pool
}

/**
 * Whether two store rows name the SAME file.
 *
 * The resolved path keeps the caller's casing, and Windows/macOS filesystems
 * are case-insensitive by default: `notesOpen` of `C:\Proj\Foo.ts` then
 * `c:\proj\foo.ts` are one file, and recording two rows would split the
 * working set (and let a case variant dodge the dedupe window). On a
 * case-sensitive filesystem (Linux) the two ARE distinct files and must not
 * merge. The flag is explicit so the rule is testable on any host.
 */
export function sameStorePath(a: string, b: string, caseInsensitive = isCaseInsensitiveFs()): boolean {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isCaseInsensitiveFs(): boolean {
  return process.platform === "win32" || process.platform === "darwin"
}

/**
 * Count an open, returning the next store.
 *
 * The dedupe window is the reason this is not just `opens + 1`. A clock that
 * jumped backwards is treated as "same moment" rather than poisoning lastOpened
 * with a future value that would then pin the entry to the top forever.
 */
export function recordOpen(
  entries: readonly FrecencyEntry[],
  target: string,
  now: number = Date.now(),
): FrecencyEntry[] {
  const existing = entries.find((e) => sameStorePath(e.path, target))
  if (!existing) {
    return prune([...entries, { path: target, opens: 1, lastOpened: now }])
  }
  const withinWindow = now - existing.lastOpened < OPENS_DEDUPE_MS
  return prune(
    entries.map((e) =>
      sameStorePath(e.path, target)
        ? {
            path: e.path,
            opens: withinWindow ? e.opens : e.opens + 1,
            lastOpened: Math.max(existing.lastOpened, now),
          }
        : e,
    ),
  )
}

/**
 * Drop the weakest entries once the store exceeds its cap.
 *
 * Cut on score rather than insertion order: an old file with a huge `opens`
 * count is exactly the entry worth keeping, and a first/last trim would discard
 * it. Ties fall back to recency so the cut is deterministic.
 */
export function prune(entries: readonly FrecencyEntry[], max: number = MAX_ENTRIES, now = Date.now()): FrecencyEntry[] {
  if (entries.length <= max) return [...entries]
  return rankByFrecency(entries, { now }).slice(0, max)
}

/** Merge two stores, taking the best-known open count and newest open per path. */
export function mergeFrecency(a: readonly FrecencyEntry[], b: readonly FrecencyEntry[]): FrecencyEntry[] {
  const byPath = new Map<string, FrecencyEntry>()
  for (const entry of [...a, ...b]) {
    // A merge must apply the same identity rule as recordOpen: on a
    // case-insensitive filesystem "Foo.ts" and "foo.ts" are the same file and
    // merging them as two rows would hand the ranker a split working set.
    const key = isCaseInsensitiveFs() ? entry.path.toLowerCase() : entry.path
    const seen = byPath.get(key)
    if (!seen) {
      byPath.set(key, entry)
      continue
    }
    byPath.set(key, {
      path: seen.path,
      opens: Math.max(seen.opens, entry.opens),
      lastOpened: Math.max(seen.lastOpened, entry.lastOpened),
    })
  }
  return [...byPath.values()]
}

/**
 * Read a store, tolerating anything.
 *
 * A truncated or hand-edited file yields `[]`, never a throw: this is read on the
 * keystroke path of `@` autocomplete, and a throw there would take the TUI down
 * over a cache file. Non-array JSON, bad rows, and a wrong version all degrade
 * to empty rather than partially loading nonsense.
 */
export function loadFrecency(filePath: string): FrecencyEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return []
  }
  if (typeof parsed !== "object" || parsed === null) return []
  const record = parsed as { version?: unknown; entries?: unknown }
  if (record.version !== FRECENCY_VERSION || !Array.isArray(record.entries)) return []
  const out: FrecencyEntry[] = []
  for (const row of record.entries) {
    if (typeof row !== "object" || row === null) continue
    const { path: p, opens, lastOpened } = row as Record<string, unknown>
    if (typeof p !== "string" || p.length === 0) continue
    if (typeof opens !== "number" || !Number.isFinite(opens) || opens <= 0) continue
    if (typeof lastOpened !== "number" || !Number.isFinite(lastOpened) || lastOpened <= 0) continue
    out.push({ path: p, opens, lastOpened })
  }
  return out
}

/**
 * Write a store atomically.
 *
 * A plain write can be interrupted mid-file, and the reader above then discards
 * the whole store — one crash would silently reset every ranking. Write a
 * sibling temp file and rename, which is atomic on the same filesystem, so a
 * reader sees either the old store or the new one and never a half-written one.
 */
export function saveFrecency(filePath: string, entries: readonly FrecencyEntry[]): void {
  const payload = JSON.stringify({ version: FRECENCY_VERSION, entries: prune(entries) })
  const tmp = `${filePath}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tmp, payload, "utf8")
  try {
    fs.renameSync(tmp, filePath)
  } catch {
    // Windows can refuse rename onto an existing file handle; the direct write is
    // still better than dropping the update entirely.
    try {
      fs.writeFileSync(filePath, payload, "utf8")
      fs.rmSync(tmp, { force: true })
    } catch {
      /* best effort — the store is a cache, never a correctness requirement */
    }
  }
}

/**
 * Load, count an open, persist, and return the ranked result.
 *
 * Persistence failures are swallowed for the same reason `loadFrecency` never
 * throws: ranking is a convenience. Losing it must not cost the user their turn.
 */
export function touchAndRank(filePath: string, target: string, options: FrecencyOptions = {}): FrecencyEntry[] {
  const now = options.now ?? Date.now()
  const next = recordOpen(loadFrecency(filePath), target, now)
  try {
    saveFrecency(filePath, next)
  } catch {
    /* best effort */
  }
  return rankByFrecency(next, { ...options, now })
}

/**
 * Where the store lives.
 *
 * Ranking is USER STATE, not project data, so it follows the same resolution as
 * the rest of the state layer: `TRAYAMBAK_STATE_DIR` wins, otherwise
 * `~/.trayambak`. Writing it into the project would dirty the user's repo on
 * every read — unacceptable for a cache.
 */
export function frecencyStorePath(): string {
  const override = process.env.TRAYAMBAK_STATE_DIR
  const root = override && override.length > 0 ? override : path.join(os.homedir(), ".trayambak")
  return path.join(root, "frecency.json")
}

/**
 * Count an open into the default store.
 *
 * The one-line form for call sites on the tool path, where a throw would be a
 * failed tool call over a cache file. Resolved per call so a test (or a later
 * process) that sets `TRAYAMBAK_STATE_DIR` is honoured immediately.
 */
export function noteOpen(target: string, now: number = Date.now()): void {
  try {
    const store = frecencyStorePath()
    saveFrecency(store, recordOpen(loadFrecency(store), target, now))
  } catch {
    /* best effort — ranking is a convenience, never a correctness requirement */
  }
}

/** Read the default store, already ranked best-first. */
export function rankedRecents(options: FrecencyOptions = {}): FrecencyEntry[] {
  return rankByFrecency(loadFrecency(frecencyStorePath()), options)
}
