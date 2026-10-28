/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Session id → transcript file, so `/resume <id>` can hand the real history to
 * the agent instead of only flipping a status string.
 *
 * The split this bridges: a session's TRANSCRIPT lives in its own JSON file
 * (`Session.save`/`Session.load`, which `Agent` already uses via `sessionFile`),
 * while the session LIST lives in one metadata file
 * (`~/.nemo/sessions.json`) that records id/name/status and nothing else.
 * Resuming by id therefore had no path to the conversation at all — the command
 * resolved the id, set `status: "active"`, and returned text. The model started
 * from an empty session and never saw the earlier turns.
 *
 * Transcripts are stored one file per session, named by id, under the sessions
 * directory. That naming is the contract; `file` was deliberately NOT added to
 * `SessionInfo` so existing metadata files keep loading unchanged.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { isRemoteUncPath } from "../../../runtime/src/config.js"
import { Session } from "../../../runtime/src/session/session.js"

/** Ids are filenames, never paths. Anything else is rejected outright. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/

export interface TranscriptTarget {
  readonly id: string
  readonly file: string
  /** Messages the transcript actually holds, so callers can be honest. */
  readonly messageCount: number
}

/** Directory holding one transcript file per session id. */
export function sessionsDir(): string {
  const explicit = process.env.NEMO_SESSIONS_DIR
  if (explicit && !isRemoteUncPath(explicit)) return explicit
  return path.join(os.homedir(), ".nemo", "sessions")
}

/**
 * Resolve a session id to its transcript file.
 *
 * The id arrives from the command line, so it is validated as a FILENAME
 * before it is ever joined: a value like `../../.ssh/id_rsa` or `a/b` would
 * otherwise turn `/resume` into an arbitrary-file read (and `Session.load`
 * would parse it). Rejecting separators and traversal keeps resolution inside
 * the sessions directory by construction.
 */
export function transcriptPathFor(id: string): string {
  if (typeof id !== "string" || !SAFE_ID.test(id) || id === "." || id === "..") {
    throw new Error(`Invalid session id: ${JSON.stringify(String(id))}`)
  }
  return path.join(sessionsDir(), id)
}

/**
 * Transcript locations an id can name, in resolution order.
 *
 * `Session.save` writes the bare `<id>`, but the transcripts that actually
 * accumulated in `~/.nemo/sessions` are `<id>.jsonl` rows from the wire
 * recorder (plus a per-session directory holding `context.jsonl`). Resolving
 * ONLY the bare name meant every real session id typed at the prompt reported
 * "no transcript found" — the session list knew the id, the file next to it had
 * a suffix.
 */
export function transcriptCandidates(id: string): string[] {
  const base = transcriptPathFor(id)
  return [base, `${base}.jsonl`, path.join(base, "context.jsonl")]
}

/**
 * Load a session's transcript, or explain why it cannot be resumed.
 *
 * `Session.load` already caps the file size and refuses remote UNC targets, so
 * this only adds the id validation and turns the outcome into something a
 * caller can report without guessing.
 */
export function loadTranscript(id: string): TranscriptTarget | { readonly error: string } {
  let candidates: string[]
  try {
    candidates = transcriptCandidates(id)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  let existing: string[]
  try {
    existing = candidates.filter((file) => fs.existsSync(file))
  } catch (error) {
    return { error: `cannot reach the sessions directory (${error instanceof Error ? error.message : String(error)})` }
  }
  if (existing.length === 0) return { error: `no transcript found for session ${id}` }
  // The first readable candidate wins; an empty-but-valid file is remembered so
  // the report says "nothing to resume" rather than "unreadable".
  let empty = false
  for (const file of existing) {
    let session: Session | null = null
    try {
      session = Session.load(file)
    } catch (error) {
      return {
        error: `transcript for ${id} could not be read (${error instanceof Error ? error.message : String(error)})`,
      }
    }
    if (session && session.messages.length > 0) return { id, file, messageCount: session.messages.length }
    if (session) empty = true
  }
  if (empty) return { error: `session ${id} has an empty transcript — there is nothing to resume` }
  return { error: `transcript for ${id} is unreadable` }
}

/** True when the value is a resumable target rather than an error. */
export function isTranscriptTarget(value: TranscriptTarget | { readonly error: string }): value is TranscriptTarget {
  return "file" in value
}
