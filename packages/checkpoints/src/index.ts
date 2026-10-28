/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/** File-snapshot checkpoints: capture/restore transcript + workdir file list. */

import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"
import { sessionsRoot, sessionDir } from "../../session-backends/src/transcript.js"

export interface Checkpoint {
  id: string
  createdAt: number
  files: string[]
  gitStash?: string
}

function cpDir(sessionId: string): string {
  return path.join(sessionDir(sessionId), ".checkpoints")
}

export function createCheckpoint(sessionId: string, workDir: string): Checkpoint {
  const id = `cp-${Date.now()}`
  const dir = path.join(cpDir(sessionId), id)
  fs.mkdirSync(dir, { recursive: true })
  const files: string[] = []
  try {
    for (const e of fs.readdirSync(workDir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".md")) files.push(e.name)
    }
  } catch {
    /* unreadable cwd */
  }
  let gitStash: string | undefined
  try {
    const out = execFileSync("git", ["stash", "push", "-m", `nemo-${id}`, "--include-untracked"], {
      cwd: workDir,
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    })
    gitStash = out.trim().slice(0, 200)
  } catch {
    /* not a git repo — file snapshot only */
  }
  const cp: Checkpoint = { id, createdAt: Date.now(), files, gitStash }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(cp, null, 2), "utf8")
  return cp
}

export function listCheckpoints(sessionId: string): Checkpoint[] {
  try {
    const base = cpDir(sessionId)
    if (!fs.existsSync(base)) return []
    return fs
      .readdirSync(base)
      .map((id) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(base, id, "manifest.json"), "utf8")) as Checkpoint
        } catch {
          return null
        }
      })
      .filter((c): c is Checkpoint => !!c)
      .sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

export function sessionsRootDir(): string {
  return sessionsRoot()
}
