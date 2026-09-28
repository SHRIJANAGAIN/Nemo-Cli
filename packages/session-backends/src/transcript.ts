/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Per-session transcript store (Kimi parity):
 *   ~/.trayambak/sessions/<uuid>/context.jsonl  (message history, JSONL)
 *   ~/.trayambak/sessions/<uuid>/wire.jsonl      (event log, JSONL)
 *   ~/.trayambak/sessions/<uuid>/state.json      (title, updatedAt, workDir)
 * Atomic 0600 writes, legacy single-file migrate, empty-session skip.
 */

import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

export interface TranscriptState {
  title: string
  updatedAt: number
  workDir: string
  customTitle?: string
}

export function sessionsRoot(): string {
  if (process.env.TRAYAMBAK_SESSIONS_DIR) return process.env.TRAYAMBAK_SESSIONS_DIR
  return path.join(os.homedir(), ".trayambak", "sessions")
}

export function newTranscriptId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`
  }
}

function atomicWrite0600(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 })
  try {
    fs.chmodSync(tmp, 0o600)
  } catch {
    /* non-POSIX */
  }
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* best effort */
  }
}

export function sessionDir(id: string): string {
  return path.join(sessionsRoot(), id)
}

export function contextFile(id: string): string {
  return path.join(sessionDir(id), "context.jsonl")
}

export function wireFile(id: string): string {
  return path.join(sessionDir(id), "wire.jsonl")
}

export function stateFile(id: string): string {
  return path.join(sessionDir(id), "state.json")
}

export function createTranscript(workDir: string, id?: string): { id: string } {
  const sid = id ?? newTranscriptId()
  const dir = sessionDir(sid)
  fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(contextFile(sid))) atomicWrite0600(contextFile(sid), "")
  if (!fs.existsSync(wireFile(sid))) atomicWrite0600(wireFile(sid), "")
  writeState(sid, { title: "Untitled", updatedAt: Date.now(), workDir })
  return { id: sid }
}

export function appendContext(id: string, record: unknown): void {
  try {
    fs.mkdirSync(sessionDir(id), { recursive: true })
    fs.appendFileSync(contextFile(id), JSON.stringify(record) + "\n", "utf8")
    touchState(id)
  } catch {
    /* transcript must never break turns */
  }
}

export function appendWire(id: string, event: unknown): void {
  try {
    fs.mkdirSync(sessionDir(id), { recursive: true })
    fs.appendFileSync(wireFile(id), JSON.stringify({ t: Date.now(), event }) + "\n", "utf8")
  } catch {
    /* best effort */
  }
}

export function readState(id: string): TranscriptState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(id), "utf8")) as TranscriptState
    if (!raw || typeof raw !== "object") return null
    return raw
  } catch {
    return null
  }
}

export function writeState(id: string, state: TranscriptState): void {
  try {
    atomicWrite0600(stateFile(id), JSON.stringify(state, null, 2))
  } catch {
    /* best effort */
  }
}

function touchState(id: string): void {
  try {
    const s = readState(id)
    if (!s) return
    s.updatedAt = Date.now()
    const first = readFirstUserText(id)
    if (first && (!s.title || s.title === "Untitled") && !s.customTitle) {
      s.title = first.slice(0, 50)
    }
    writeState(id, s)
  } catch {
    /* best effort */
  }
}

function readFirstUserText(id: string): string | null {
  try {
    const file = wireFile(id)
    if (!fs.existsSync(file)) return null
    const lines = fs.readFileSync(file, "utf8").split("\n").slice(0, 50)
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const rec = JSON.parse(line) as { event?: { user_input?: string; type?: string } }
        const text = rec?.event?.user_input
        if (typeof text === "string" && text.trim()) return text.trim()
      } catch {
        continue
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

export function isEmptyTranscript(id: string): boolean {
  try {
    const s = readState(id)
    if (s?.customTitle) return false
    for (const f of [contextFile(id), wireFile(id)]) {
      if (!fs.existsSync(f)) continue
      const content = fs.readFileSync(f, "utf8").trim()
      if (content.length > 0) return false
    }
    return true
  } catch {
    return false
  }
}

export function listTranscripts(): Array<{ id: string; state: TranscriptState | null }> {
  const root = sessionsRoot()
  try {
    if (!fs.existsSync(root)) return []
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ id: e.name, state: readState(e.name) }))
      .filter((t) => !isEmptyTranscript(t.id))
      .sort((a, b) => (b.state?.updatedAt ?? 0) - (a.state?.updatedAt ?? 0))
  } catch {
    return []
  }
}

/** Migrate legacy single-file transcript (<sessions>/<id>.jsonl) to dir layout. */
export function migrateLegacyFile(id: string): void {
  try {
    const legacy = path.join(sessionsRoot(), `${id}.jsonl`)
    const dest = contextFile(id)
    if (fs.existsSync(legacy) && !fs.existsSync(dest)) {
      fs.mkdirSync(sessionDir(id), { recursive: true })
      fs.renameSync(legacy, dest)
    }
  } catch {
    /* best effort */
  }
}
