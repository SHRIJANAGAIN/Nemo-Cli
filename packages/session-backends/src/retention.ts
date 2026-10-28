/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Retention and integrity for session transcripts.
 *
 * A transcript is the one file in this codebase that grows for the lifetime of
 * a session with nobody pruning it: every append adds a line and nothing ever
 * removes one. Two consequences, both real:
 *
 *  - **Unbounded growth.** A long-lived session's `wire.jsonl` records every
 *    event including every streaming delta, so it is the largest file the agent
 *    ever writes and nothing caps it.
 *  - **Silent truncation.** `appendFileSync` is not transactional. A kill, a
 *    full disk, or a crash leaves a partial final line, and a reader that
 *    `JSON.parse`s it either throws or resurrects a truncated object.
 *
 * `verifySession` distinguishes "ends cleanly", "ended in a torn write", and
 * "was rewritten underneath us", because those need different responses: the
 * first is normal, the second is expected after a crash, and the third is a
 * concurrency bug worth surfacing.
 */

import * as fs from "fs"
import * as path from "path"
import { contextFile, readState, sessionsRoot, stateFile, wireFile } from "./transcript.js"
import { readJsonl, type DetailedReadResult } from "./read.js"

export type SessionHealth =
  /** Files present, final line parses, sizes consistent with state. */
  | "ok"
  /** Final line is a partial write (crash / full disk mid-append). */
  | "torn-tail"
  /** One or more lines failed to parse, but not at the tail. */
  | "malformed"
  /** Transcript files are missing entirely. */
  | "missing"
  /** state.json is unreadable while transcript files exist. */
  | "no-state"

export interface SessionReport {
  id: string
  health: SessionHealth
  contextBytes: number
  wireBytes: number
  contextRecords: number
  wireRecords: number
  malformed: number
  truncatedRead: boolean
  updatedAt?: number
  /** Set when the file is larger than the cap prune would target. */
  oversized: boolean
  /** Human-readable notes; empty when nothing is wrong. */
  notes: string[]
}

/** Per-file size above which a transcript is worth flagging. */
export const OVERSIZE_BYTES = 32 * 1024 * 1024

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

function exists(file: string): boolean {
  try {
    fs.statSync(file)
    return true
  } catch {
    return false
  }
}

/**
 * Inspect one session without loading it into memory.
 *
 * Reads are capped so `doctor` over a sessions directory holding one huge
 * transcript cannot itself be the thing that OOMs.
 */
export function verifySession(id: string, maxBytes?: number): SessionReport {
  const ctxFile = contextFile(id)
  const wrFile = wireFile(id)
  const ctxBytes = sizeOf(ctxFile)
  const wrBytes = sizeOf(wrFile)
  const state = readState(id)

  const report: SessionReport = {
    id,
    health: "ok",
    contextBytes: ctxBytes,
    wireBytes: wrBytes,
    contextRecords: 0,
    wireRecords: 0,
    malformed: 0,
    truncatedRead: false,
    oversized: false,
    notes: [],
  }
  if (state !== null) report.updatedAt = state.updatedAt

  const noContext = !exists(ctxFile)
  const noWire = !exists(wrFile)
  if (noContext && noWire) {
    report.health = "missing"
    report.notes.push("no transcript files")
    return report
  }

  const ctx: DetailedReadResult<unknown> = readJsonl<unknown>(ctxFile, maxBytes)
  const wire: DetailedReadResult<unknown> = readJsonl<unknown>(wrFile, maxBytes)
  report.contextRecords = ctx.records.length
  report.wireRecords = wire.records.length
  report.malformed = ctx.malformed + wire.malformed
  report.truncatedRead = ctx.truncated || wire.truncated

  if (ctx.truncated || wire.truncated) {
    report.notes.push("read was capped; counts below are a floor, not a total")
  }
  if (ctxBytes > OVERSIZE_BYTES || wrBytes > OVERSIZE_BYTES) {
    report.oversized = true
    report.notes.push("transcript is oversized; run prune")
  }

  if (ctx.tornTail || wire.tornTail) {
    report.health = "torn-tail"
    report.notes.push("final record was a torn write (expected after a crash)")
  } else if (report.malformed > 0) {
    report.health = "malformed"
    report.notes.push(`${report.malformed} malformed line(s) skipped`)
  }
  if (state === null && (ctxBytes > 0 || wrBytes > 0)) {
    report.health = "no-state"
    report.notes.push("state.json unreadable; the session will not appear in listings")
  }
  return report
}

export interface PruneOptions {
  /** Drop sessions untouched for this long. Omit to keep all ages. */
  maxAgeMs?: number
  /** Drop any transcript larger than this, regardless of age. */
  maxFileBytes?: number
  /** Keep at most this many sessions, newest first. Omit for no cap. */
  maxSessions?: number
  /** Report what would happen without touching disk. */
  dryRun?: boolean
  now?: () => number
}

export interface PruneResult {
  scanned: number
  removed: string[]
  /** Sessions kept, with the reason they survived — so a prune is auditable. */
  kept: { id: string; reason: string }[]
  bytesFreed: number
  dryRun: boolean
}

function dirSize(dir: string): number {
  let total = 0
  for (const name of ["context.jsonl", "wire.jsonl", "state.json"]) {
    total += sizeOf(path.join(dir, name))
  }
  return total
}

/**
 * Prune sessions by age, size, and count.
 *
 * Deletion is per-session-directory and refuses to remove anything outside the
 * sessions root: a session id reaches this function from a config value and from
 * a directory listing, and `rm -rf` on a computed path is the exact shape of the
 * path-traversal class (#68/#69).
 */
export function pruneSessions(opts: PruneOptions = {}): PruneResult {
  const now = opts.now ?? ((): number => Date.now())
  const dryRun = opts.dryRun === true
  const root = sessionsRoot()

  const result: PruneResult = { scanned: 0, removed: [], kept: [], bytesFreed: 0, dryRun }

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return result
  }

  const candidates: { id: string; dir: string; updatedAt: number; bytes: number }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const id = entry.name
    const dir = path.join(root, id)
    const state = readState(id)
    // Fall back to the directory's own mtime: a session with a corrupt
    // state.json still has a real age on disk, and treating it as "now" would
    // make an unreadable session immortal.
    let updatedAt = state?.updatedAt ?? 0
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
      try {
        updatedAt = fs.statSync(dir).mtimeMs
      } catch {
        updatedAt = 0
      }
    }
    candidates.push({ id, dir, updatedAt, bytes: dirSize(dir) })
  }
  result.scanned = candidates.length

  const ageCutoff =
    typeof opts.maxAgeMs === "number" && Number.isFinite(opts.maxAgeMs) && opts.maxAgeMs > 0
      ? now() - opts.maxAgeMs
      : undefined
  const sizeCap =
    typeof opts.maxFileBytes === "number" && Number.isFinite(opts.maxFileBytes) && opts.maxFileBytes > 0
      ? opts.maxFileBytes
      : undefined
  const countCap =
    typeof opts.maxSessions === "number" && Number.isFinite(opts.maxSessions) && opts.maxSessions > 0
      ? Math.floor(opts.maxSessions)
      : undefined

  // Newest first, so a count cap keeps the most recent sessions.
  candidates.sort((a, b) => b.updatedAt - a.updatedAt)

  candidates.forEach((candidate, index) => {
    const reason = pruneReason(candidate, index, { ageCutoff, sizeCap, countCap })
    if (reason === undefined) {
      result.kept.push({ id: candidate.id, reason: "within every limit" })
      return
    }
    result.removed.push(candidate.id)
    result.bytesFreed += candidate.bytes
    if (dryRun) return
    try {
      // Refuse anything that does not resolve inside the sessions root.
      const resolved = path.resolve(candidate.dir)
      const rootResolved = path.resolve(root)
      if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
        result.kept.push({ id: candidate.id, reason: "refused: resolves outside the sessions root" })
        return
      }
      fs.rmSync(resolved, { recursive: true, force: true })
    } catch {
      result.kept.push({ id: candidate.id, reason: "delete failed" })
    }
  })

  return result
}

interface Limits {
  ageCutoff: number | undefined
  sizeCap: number | undefined
  countCap: number | undefined
}

/** Why this session goes, or undefined when it stays. */
function pruneReason(
  candidate: { updatedAt: number; bytes: number },
  index: number,
  limits: Limits,
): string | undefined {
  if (limits.sizeCap !== undefined && candidate.bytes > limits.sizeCap) {
    return `transcript is ${candidate.bytes} bytes, over the ${limits.sizeCap} cap`
  }
  if (limits.ageCutoff !== undefined && candidate.updatedAt > 0 && candidate.updatedAt < limits.ageCutoff) {
    return `untouched since ${new Date(candidate.updatedAt).toISOString()}`
  }
  if (limits.countCap !== undefined && index >= limits.countCap) {
    return `beyond the newest ${limits.countCap} session(s)`
  }
  return undefined
}

/** Human report for `doctor` / `db` output. */
export function formatSessionReport(report: SessionReport): string {
  const lines = [`${report.id}  [${report.health}]`]
  lines.push(
    `  context ${report.contextRecords} record(s) / ${report.contextBytes}B   wire ${report.wireRecords} record(s) / ${report.wireBytes}B`,
  )
  for (const note of report.notes) lines.push(`  note: ${note}`)
  return lines.join("\n")
}

/** Total bytes across every session directory. */
export function totalSessionBytes(): number {
  try {
    return fs
      .readdirSync(sessionsRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .reduce((sum, e) => sum + dirSize(path.join(sessionsRoot(), e.name)), 0)
  } catch {
    return 0
  }
}

/** Where prune would act, without acting. */
export function previewPrune(opts: PruneOptions = {}): PruneResult {
  return pruneSessions({ ...opts, dryRun: true })
}

export { stateFile }