/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * SKT AI LABS `@`-mention port for the Ink composer: find the in-progress `@query`
 * ending at the cursor, keep a cached workspace file list, rank it fuzzy, and
 * insert the picked path back into the buffer.
 *
 * Design ported from SKT AI LABS's useFileMention.ts / file-mention-utils.ts,
 * simplified for a single-line append-only composer (no left/right cursor, so
 * "at the cursor" == end of buffer): files + folders only — no sessions,
 * worktrees, or VS Code attachment plumbing. The inserted `@path` travels
 * inside the prompt text where the model sees it.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { fuzzyMatchScore } from "./fuzzy.js"

export interface MentionCandidate {
  /** Workspace-relative path with forward slashes; folders keep a trailing "/". */
  value: string
  kind: "file" | "folder"
}

export interface MentionState {
  /** Query text after the trigger `@` (trailing whitespace trimmed). */
  query: string
  /** Buffer index of the triggering `@`. */
  atIndex: number
}

/**
 * The in-progress `@query` ending at the cursor. `@` must start the buffer or
 * follow whitespace (so `user@host` never triggers), the query may contain
 * spaces (paths like `my report.txt` stay searchable), and a later ` @`
 * restarts the query so a second mention isn't swallowed by the first — all
 * ported verbatim from SKT AI LABS's AT_PATTERN.
 */
export const AT_PATTERN = /(?:^|\s)@(?![^\n]*\s@)([^\n]*)$/

/**
 * Whether an inserted mention is followed by prose rather than a longer
 * filename being typed: the query must start with the token that was actually
 * inserted at this `@`, the next char must be whitespace, and no LONGER known
 * path may still extend the whole query (that would mean the user is typing
 * toward e.g. `src/a.tsx` instead of moving on). Ported from SKT AI LABS's
 * mentionSettled.
 */
export function mentionSettled(rawQuery: string, token: string | undefined, known: readonly string[]): boolean {
  if (!token || rawQuery.length <= token.length) return false
  if (!rawQuery.startsWith(token)) return false
  if (!/\s/.test(rawQuery[token.length] ?? "")) return false
  return !known.some((k) => k.length > rawQuery.length && k.startsWith(rawQuery))
}

/**
 * Derive the active mention from the whole buffer (the composer is
 * append-only, so the mention always ends at the buffer's end). `token` is
 * the `{atIndex, token}` pair of the last inserted path — only consulted when
 * the current mention sits at that same `@`. Returns null when no mention is
 * open (including when the mention has settled into prose).
 */
export function deriveMentionState(
  buffer: string,
  known: readonly string[] = [],
  token?: { atIndex: number; token: string },
): MentionState | null {
  const m = AT_PATTERN.exec(buffer)
  if (!m) return null
  const rel = (m[0] ?? "").startsWith("@") ? 0 : 1
  const atIndex = m.index + rel
  const rawQuery = m[1] ?? ""
  if (token && token.atIndex === atIndex && mentionSettled(rawQuery, token.token, known)) return null
  return { query: rawQuery.replace(/\s+$/, ""), atIndex }
}

/**
 * Rank candidates for `query`: path score plus a basename bonus so
 * `agent.ts` jumps above deep paths that merely contain the letters. Empty
 * query → folders first, then files, alphabetical (stable order for
 * arrow-key browsing). Bounded by `limit`.
 */
export function filterMentions(query: string, candidates: readonly MentionCandidate[], limit = 50): MentionCandidate[] {
  const q = query.trim()
  if (!q) {
    return [...candidates]
      .sort((a, b) => (a.kind === b.kind ? a.value.localeCompare(b.value) : a.kind === "folder" ? -1 : 1))
      .slice(0, limit)
  }
  const scored: Array<{ c: MentionCandidate; score: number }> = []
  for (const c of candidates) {
    const base = c.value.split("/").pop() ?? c.value
    const score = fuzzyMatchScore(c.value, q) + fuzzyMatchScore(base, q) * 1.5
    if (score > 0) scored.push({ c, score })
  }
  scored.sort((a, b) => b.score - a.score || a.c.value.length - b.c.value.length)
  return scored.slice(0, limit).map((e) => e.c)
}

/**
 * Replace the in-progress `@query` before the cursor with `@path` and append a
 * separating space unless the text after the cursor already starts with
 * whitespace. Ported from SKT AI LABS's buildTextAfterMentionSelect.
 */
export function insertMention(before: string, after: string, candidatePath: string): string {
  const replaced = before.replace(AT_PATTERN, (match) =>
    match.startsWith(" ") ? ` @${candidatePath}` : `@${candidatePath}`,
  )
  const suffix = /^\s/.test(after) ? "" : " "
  return replaced + suffix + after
}

/** Heavy generated trees a workspace search must never descend into. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-esm",
  "build",
  "out",
  "coverage",
  ".cache",
  ".trayambak",
  ".next",
  ".nuxt",
  ".turbo",
  ".yarn",
  ".pnpm-store",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  "target",
  ".terraform",
  ".gradle",
])

const MAX_FILES = 4000
const MAX_DEPTH = 10
/** Re-walk at most this often — the menu re-derives on every keystroke. */
const CACHE_TTL_MS = 30_000

export interface MentionFileCache {
  dir: string
  entries: MentionCandidate[]
  loadedAt: number
}

let cache: MentionFileCache | null = null
let walking = false
const listeners = new Set<() => void>()

function notifyListeners(): void {
  for (const cb of listeners) {
    try {
      cb()
    } catch {
      /* a broken listener must never break the menu */
    }
  }
}

/** Subscribe to cache updates — components bump a revision state to re-render. */
export function subscribeMentionFiles(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/**
 * One bounded workspace walk: files and folders as workspace-relative
 * forward-slash paths (folders keep a "/"), skipping heavy generated dirs.
 * Depth- and count-capped, and never throws — an unreadable entry is simply
 * skipped.
 */
export async function walkProjectFiles(dir: string): Promise<MentionCandidate[]> {
  interface WorkItem {
    abs: string
    rel: string
    depth: number
  }
  const out: MentionCandidate[] = []
  const queue: WorkItem[] = [{ abs: dir, rel: "", depth: 0 }]
  while (queue.length > 0 && out.length < MAX_FILES) {
    const cur = queue.shift()
    if (!cur) break
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(cur.abs, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (out.length >= MAX_FILES) break
      const rel = cur.rel ? `${cur.rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue
        out.push({ value: `${rel}/`, kind: "folder" })
        if (cur.depth + 1 < MAX_DEPTH) {
          queue.push({ abs: path.join(cur.abs, e.name), rel, depth: cur.depth + 1 })
        }
      } else if (e.isFile() || e.isSymbolicLink()) {
        out.push({ value: rel, kind: "file" })
      }
    }
  }
  return out
}

/** Snapshot for the render pass — empty until the walk for `dir` lands. */
export function listMentionFiles(dir: string): MentionCandidate[] {
  if (!cache || cache.dir !== dir) return []
  return cache.entries
}

/**
 * Kick off (or refresh, after CACHE_TTL_MS) the async workspace walk for
 * `dir`. Call it when the `@` menu opens; listeners fire when the result
 * lands so the open menu fills in without a keystroke.
 */
export function ensureMentionFiles(dir: string, opts?: { force?: boolean }): void {
  if (!dir || walking) return
  if (cache && cache.dir === dir && !opts?.force && Date.now() - cache.loadedAt < CACHE_TTL_MS) return
  walking = true
  void walkProjectFiles(dir)
    .then((entries) => {
      cache = { dir, entries, loadedAt: Date.now() }
    })
    .catch(() => {
      /* keep whatever we had — an unlistable workspace just shows nothing */
    })
    .finally(() => {
      walking = false
      notifyListeners()
    })
}
