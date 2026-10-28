/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Read side of the transcript store.
 *
 * `transcript.ts` writes `context.jsonl` and `wire.jsonl` but nothing ever read
 * them back: there was no read API at all, so a transcript was effectively
 * write-only. Resume, fork, and export each re-derived what they could from
 * `state.json` and lost the actual history.
 *
 * Three properties this module is built around, each earned by a real failure:
 *
 *  1. **Bounded reads.** #119 was five text tools calling `readFileSync` on a
 *     whole multi-GB file and OOM-ing the CLI. A transcript is a file the agent
 *     itself appends to for the life of a session, so it is exactly the shape
 *     that grows without limit. Every read here is byte-capped and reports what
 *     it truncated.
 *
 *  2. **Tolerant of a torn last line.** `appendFileSync` is not transactional:
 *     a crash, a full disk, or a kill mid-write leaves a partial final line.
 *     `JSON.parse` on it throws and a naive reader loses the whole transcript.
 *     Malformed lines are quarantined and counted, never fatal.
 *
 *  3. **No silent drops.** A skipped line is REPORTED. A resume that quietly
 *     loses history is worse than one that refuses, because the user cannot
 *     tell the difference.
 */

import * as fs from "fs"
import { contextFile, wireFile } from "./transcript.js"

/** Hard ceiling on a single transcript read. A 64 MiB transcript is already
 *  pathological; refusing past it is cheaper than the OOM. */
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024

/** Default cap when a caller does not pass one. */
export const DEFAULT_READ_BYTES = 8 * 1024 * 1024

export interface WireRecord {
  /** Envelope timestamp written by appendWire. */
  t?: number
  event?: unknown
  [key: string]: unknown
}

export interface ReadResult<T> {
  records: T[]
  /** Bytes actually inspected. */
  bytesRead: number
  /** File size on disk, which may exceed `bytesRead`. */
  fileBytes: number
  /** True when the file was longer than the cap. */
  truncated: boolean
  /** Lines that failed to parse and were skipped. */
  malformed: number
  /** Number of skipped lines that were in the FINAL position (a torn write). */
  tornTail: boolean
}

/** One line that could not be parsed, with enough context to act on it. */
export interface QuarantinedLine {
  /** 1-based line number in the file. */
  line: number
  /** Truncated preview (never the whole line — it may hold a secret). */
  preview: string
}

export interface DetailedReadResult<T> extends ReadResult<T> {
  quarantined: QuarantinedLine[]
}

function emptyResult<T>(fileBytes: number): DetailedReadResult<T> {
  return {
    records: [],
    bytesRead: 0,
    fileBytes,
    truncated: false,
    malformed: 0,
    tornTail: false,
    quarantined: [],
  }
}

const PREVIEW_CHARS = 120

function preview(line: string): string {
  const flat = line.replace(/\s+/g, " ").trim()
  return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS)}…`
}

/**
 * Read a JSONL file, tolerantly and boundedly.
 *
 * `file` is passed in rather than derived so this works for the context file,
 * the wire file, and any export the caller is reading — the parse rules are
 * identical for all three, and a second copy is how they drift.
 */
export function readJsonl<T>(file: string, maxBytes: number = DEFAULT_READ_BYTES): DetailedReadResult<T> {
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    // A missing transcript is an empty transcript, not an error: a session can
    // legitimately have a state.json and no context yet.
    return emptyResult<T>(0)
  }
  const fileBytes = stat.size
  if (fileBytes === 0) return emptyResult<T>(0)

  // A cap of 0/NaN/negative falls back to the DEFAULT rather than clamping to a
// single byte: a one-byte read parses nothing, so a caller who passed 0 (or a
// NaN from a bad config value) would silently get an empty transcript — the
// same "looks like it worked" failure this module exists to avoid.
const requested = typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_READ_BYTES
const limit = Math.min(requested, MAX_TRANSCRIPT_BYTES)
  const bytesToRead = Math.min(fileBytes, limit)
  const truncated = bytesToRead < fileBytes

  let raw: string
  let handle: number | undefined
  try {
    handle = fs.openSync(file, "r")
    const buffer = Buffer.allocUnsafe(bytesToRead)
    const read = fs.readSync(handle, buffer, 0, bytesToRead, 0)
    raw = buffer.subarray(0, read).toString("utf8")
  } catch {
    return emptyResult<T>(fileBytes)
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle)
      } catch {
        /* already closed */
      }
    }
  }

  // The final fragment is KEPT and parsed rather than dropped. An earlier
  // version popped it, which silently discarded the record after a torn write —
  // precisely the "no silent drops" failure this module exists to prevent, and it
  // made the tornTail flag unreachable. Keeping it means a partial record fails
  // to parse, is quarantined, and is REPORTED as a torn tail.
  const lines = raw.split("\n")
  const trailingNewline = raw.endsWith("\n")
  if (trailingNewline && lines.length > 0) {
    lines.pop() // the empty string after the final newline
  }

  const result = emptyResult<T>(fileBytes)
  result.bytesRead = bytesToRead
  result.truncated = truncated

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim().length === 0) continue
    const isLast = i === lines.length - 1
    try {
      result.records.push(JSON.parse(line) as T)
    } catch {
      result.malformed += 1
      result.quarantined.push({ line: i + 1, preview: preview(line) })
      }
  }
  // A file that does not end in a newline ended mid-append, whatever its last
  // line happens to parse as. Set from the FILE, not from the parse failure: a
  // torn write whose fragment happens to be valid JSON is still a torn write,
  // and conditioning on the failure made the flag miss exactly that case.
  if (!trailingNewline && lines.length > 0) result.tornTail = true
  return result
}

/** Read `context.jsonl` — the message history. */
export function readContext(sessionId: string, maxBytes?: number): DetailedReadResult<unknown> {
  return readJsonl<unknown>(contextFile(sessionId), maxBytes)
}

/** Read `wire.jsonl` — the raw event log. */
export function readWire(sessionId: string, maxBytes?: number): DetailedReadResult<WireRecord> {
  return readJsonl<WireRecord>(wireFile(sessionId), maxBytes)
}

/** The last N context records, without reading the whole file twice.
 *
 * Used by export and resume-tail. `keep` is clamped so a caller asking for
 * "everything" still gets a bounded read.
 */
export function readContextTail(sessionId: string, keep: number, maxBytes?: number): DetailedReadResult<unknown> {
  const result = readContext(sessionId, maxBytes)
  if (!Number.isFinite(keep) || keep <= 0) {
    result.records = []
    return result
  }
  if (result.records.length > keep) {
    result.records = result.records.slice(-Math.floor(keep))
  }
  return result
}

/** Shape check for a context record.
 *
 * The file is untrusted input on resume: it is whatever the previous process
 * wrote, and a user can hand-edit it. A record that is not a message-shaped
 * object is reported rather than spread into the session.
 */
export function isMessageRecord(value: unknown): value is { role: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const role = (value as { role?: unknown }).role
  return role === "user" || role === "assistant" || role === "tool" || role === "system"
}

/** Context records that are actually message-shaped, plus the rejected count. */
export interface ContextLoad {
  messages: { role: string }[]
  rejected: number
  truncated: boolean
  malformed: number
  tornTail: boolean
}

/**
 * Load a session's message history for resume.
 *
 * `system` records are DROPPED rather than rejected: `appendContext` already
 * refuses to persist them, so a system row in the file means it came from a
 * hand-edit or an older writer. Re-injecting it would put text the user never
 * typed into the model's system position, which is a privilege the file should
 * not be able to grant.
 */
export function loadContextForResume(
  sessionId: string,
  maxBytes?: number,
): ContextLoad {
  const raw = readContext(sessionId, maxBytes)
  const messages: { role: string }[] = []
  let rejected = 0
  for (const record of raw.records) {
    if (!isMessageRecord(record)) {
      rejected += 1
      continue
    }
    if (record.role === "system") continue
    messages.push(record)
  }
  return {
    messages,
    rejected,
    truncated: raw.truncated,
    malformed: raw.malformed,
    tornTail: raw.tornTail,
  }
}

/** One-line human summary of a read, for `doctor` and resume warnings. */
export function describeRead(result: ReadResult<unknown>): string {
  const parts: string[] = [`${result.records.length} record(s)`]
  if (result.truncated) parts.push(`truncated at ${result.bytesRead} of ${result.fileBytes} bytes`)
  if (result.malformed > 0) parts.push(`${result.malformed} malformed line(s) skipped`)
  if (result.tornTail) parts.push("final record was a torn write")
  return parts.join(", ")
}