/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import * as fs from "fs"
import * as path from "path"
import { sessionsRoot, sessionDir, assertSessionId } from "../../../../packages/session-backends/src/transcript.js"
import { failOutput, usageOutput } from "../command-registry.js"

/** Invalid IDs and misses are operational failures, never silent success. */
function invalidId(id: string): string {
  return usageOutput(`invalid session id: ${id}`)
}

function checkedId(id: string): boolean {
  try {
    assertSessionId(id)
    return true
  } catch {
    return false
  }
}

export function archiveSession(id: string): string {
  if (!checkedId(id)) return invalidId(id)
  const dir = sessionDir(id)
  if (!fs.existsSync(dir)) return failOutput(`session not found: ${id}`)
  const dest = path.join(sessionsRoot(), ".archived", id)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.renameSync(dir, dest)
  return `archived ${id}`
}

export function unarchiveSession(id: string): string {
  if (!checkedId(id)) return invalidId(id)
  const src = path.join(sessionsRoot(), ".archived", id)
  if (!fs.existsSync(src)) return failOutput(`archived session not found: ${id}`)
  fs.renameSync(src, sessionDir(id))
  return `unarchived ${id}`
}

export function deleteSession(id: string): string {
  if (!checkedId(id)) return invalidId(id)
  for (const base of [sessionDir(id), path.join(sessionsRoot(), ".archived", id)]) {
    if (fs.existsSync(base)) fs.rmSync(base, { recursive: true, force: true })
  }
  return `deleted ${id}`
}
