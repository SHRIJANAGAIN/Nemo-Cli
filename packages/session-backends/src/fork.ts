/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Forking a session: a real deep copy with recorded provenance.
 *
 * `/fork` is advertised as "an independent copy with full history". A shallow
 * copy would share the transcript files, so the fork and its parent would
 * interleave writes into the same log and a resume of either would show the
 * other's turns. So the copy is by CONTENT, the fork gets its own id, and it
 * records where it came from — because a fork with no recorded parent is a
 * session whose provenance has to be reconstructed by guessing from timestamps.
 */

import * as fs from "fs"
import {
  appendContext,
  appendWire,
  contextFile,
  createTranscript,
  readState,
  sessionDir,
  stateFile,
  wireFile,
  type TranscriptState,
} from "./transcript.js"
import { readContext, readWire } from "./read.js"

export interface ForkOptions {
  /** Session to copy. */
  parentId: string
  /** Override the new id; one is generated when absent. */
  newId?: string
  /** Title for the fork. Defaults to the parent's title plus a suffix. */
  title?: string
  /** Cap the read so forking a huge transcript is bounded. */
  maxBytes?: number
  now?: () => number
}

export interface ForkResult {
  ok: boolean
  id: string
  parentId: string
  messagesCopied: number
  eventsCopied: number
  /** Set when the copy was bounded and is therefore partial. */
  truncated: boolean
  notes: string[]
}

/** Provenance, recorded on the child so the link survives without guessing. */
export interface ForkProvenance {
  forkedFrom: string
  forkedAt: number
  messagesAtFork: number
}

const PROVENANCE = "fork.json"

function provenanceFile(id: string): string {
  return `${sessionDir(id)}/${PROVENANCE}`
}

export function readProvenance(id: string): ForkProvenance | null {
  try {
    const raw = JSON.parse(fs.readFileSync(provenanceFile(id), "utf8")) as ForkProvenance
    if (typeof raw?.forkedFrom === "string" && raw.forkedFrom.length > 0) return raw
    return null
  } catch {
    return null
  }
}

function writeProvenance(id: string, provenance: ForkProvenance): void {
  try {
    const file = provenanceFile(id)
    fs.mkdirSync(sessionDir(id), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(provenance, null, 2), { encoding: "utf8", mode: 0o600 })
  } catch {
    /* best effort: a missing provenance link is not worth failing the fork */
  }
}

/**
 * Copy a session into a new, independent one.
 *
 * The parent's files are never opened for writing, and the child gets its own
 * directory — so the two diverge cleanly from the first append onward.
 */
export function forkSession(opts: ForkOptions): ForkResult {
  const now = opts.now ?? ((): number => Date.now())
  const notes: string[] = []
  const parentState = readState(opts.parentId)

  if (parentState === null) {
    return {
      ok: false,
      id: "",
      parentId: opts.parentId,
      messagesCopied: 0,
      eventsCopied: 0,
      truncated: false,
      notes: [`session "${opts.parentId}" was not found`],
    }
  }

  const context = readContext(opts.parentId, opts.maxBytes)
  const wire = readWire(opts.parentId, opts.maxBytes)
  if (context.truncated || wire.truncated) notes.push("parent transcript exceeded the read cap; the fork is partial")
  if (context.malformed > 0) notes.push(`${context.malformed} malformed context line(s) were not copied`)
  if (wire.malformed > 0) notes.push(`${wire.malformed} malformed event line(s) were not copied`)

  // Work from a scratch id first so a failure part-way cannot leave a
  // half-populated session under the FINAL id the caller will resume from.
  const scratch = createTranscript(parentState.workDir).id
  let messagesCopied = 0
  let eventsCopied = 0
  try {
    // Re-write by content rather than copying bytes: this normalises any
    // malformed line out of the child instead of inheriting it.
    fs.writeFileSync(contextFile(scratch), "", "utf8")
    for (const record of context.records) {
      appendContext(scratch, record)
      messagesCopied += 1
    }
    fs.writeFileSync(wireFile(scratch), "", "utf8")
    for (const record of wire.records) {
      // appendWire, NOT appendContext: the context file is the message history
      // the loop resumes from, and mixing raw event envelopes into it would
      // make every forked session fail `isMessageRecord` on resume.
      appendWire(scratch, record.event ?? record)
      eventsCopied += 1
    }
  } catch (error) {
    return {
      ok: false,
      id: "",
      parentId: opts.parentId,
      messagesCopied,
      eventsCopied,
      truncated: context.truncated || wire.truncated,
      notes: [...notes, `fork failed: ${error instanceof Error ? error.message : String(error)}`],
    }
  }

  const id = opts.newId ?? scratch
  if (id !== scratch) {
    // Caller-supplied id: move the scratch directory into place.
    try {
      fs.renameSync(sessionDir(scratch), sessionDir(id))
    } catch (error) {
      return {
        ok: false,
        id: "",
        parentId: opts.parentId,
        messagesCopied,
        eventsCopied,
        truncated: false,
        notes: [...notes, `could not place the fork at "${id}": ${error instanceof Error ? error.message : String(error)}`],
      }
    }
  }

  const title = opts.title ?? `${parentState.title ?? "Untitled"} (fork)`
  const childState: TranscriptState = {
    title,
    updatedAt: now(),
    workDir: parentState.workDir,
    ...(parentState.customTitle !== undefined ? { customTitle: parentState.customTitle } : {}),
  }
  try {
    fs.writeFileSync(stateFile(id), JSON.stringify(childState, null, 2), { encoding: "utf8", mode: 0o600 })
  } catch {
    /* best effort */
  }
  writeProvenance(id, { forkedFrom: opts.parentId, forkedAt: now(), messagesAtFork: messagesCopied })

  return {
    ok: true,
    id,
    parentId: opts.parentId,
    messagesCopied,
    eventsCopied,
    truncated: context.truncated || wire.truncated,
    notes,
  }
}

/** The ancestor chain of a fork, newest first. */
export function forkChain(id: string, maxHops = 32): string[] {
  const chain: string[] = []
  let current: string | undefined = id
  for (let hop = 0; hop < maxHops && current !== undefined; hop++) {
    const provenance = readProvenance(current)
    if (provenance === null) break
    chain.push(provenance.forkedFrom)
    current = provenance.forkedFrom
  }
  return chain
}