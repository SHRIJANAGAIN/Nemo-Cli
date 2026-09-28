/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import * as fs from "fs"
import * as path from "path"
import { sessionsRoot, sessionDir } from "../../../../packages/session-backends/src/transcript.js"

export function archiveSession(id: string): string {
  const dir = sessionDir(id)
  if (!fs.existsSync(dir)) return `session not found: ${id}`
  const dest = path.join(sessionsRoot(), ".archived", id)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.renameSync(dir, dest)
  return `archived ${id}`
}

export function unarchiveSession(id: string): string {
  const src = path.join(sessionsRoot(), ".archived", id)
  if (!fs.existsSync(src)) return `archived session not found: ${id}`
  fs.renameSync(src, sessionDir(id))
  return `unarchived ${id}`
}

export function deleteSession(id: string): string {
  for (const base of [sessionDir(id), path.join(sessionsRoot(), ".archived", id)]) {
    if (fs.existsSync(base)) fs.rmSync(base, { recursive: true, force: true })
  }
  return `deleted ${id}`
}
