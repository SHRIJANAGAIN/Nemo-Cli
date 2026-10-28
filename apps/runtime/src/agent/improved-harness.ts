/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The harness the agent already learned, rendered for the next session.
 *
 * `harnessCommand` writes an adopted harness to `~/.nemo/harness` and
 * files its lessons under `library/`. Nothing used to read either back, so
 * the recursion only paid off when the user ran `/harness apply` — the
 * improvement stayed on disk. This module closes that loop: every system
 * prompt refresh picks up the active harness and the newest lessons, so
 * the next session starts from what the previous one learned, with no
 * command in between.
 *
 * Two bounds keep a runaway harness from eating the working context: the
 * always-on body is capped, and the lesson index is capped.
 */

import * as fs from "fs"
import { homedir } from "os"
import { join } from "path"
import {
  NEMO_SURFACE,
  readTree,
  renderHarness,
} from "../../../../packages/core/src/harness/index.js"

/** How much of the adopted harness body reaches the prompt. */
const MAX_HARNESS_CHARS = 6_000

/** How much of the lesson library reaches the prompt. */
const MAX_LESSON_CHARS = 2_000

/** Re-read at most this often; a session refreshes its prompt every turn. */
const CACHE_TTL_MS = 30_000

interface CachedBlock {
  at: number
  text: string
}

const cache = new Map<string, CachedBlock>()

/** The directory `harnessCommand` maintains. */
export function harnessHome(home: string = homedir()): string {
  return join(home, ".nemo", "harness")
}

/**
 * The block for the system prompt, or "" when nothing was adopted yet.
 *
 * Never throws: a corrupt harness must not stop a session from starting,
 * exactly like a failed update check.
 */
export function loadImprovedHarnessBlock(home: string = homedir(), now: number = Date.now()): string {
  const root = harnessHome(home)
  const cached = cache.get(root)
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.text
  const text = buildBlock(root)
  cache.set(root, { at: now, text })
  return text
}

function buildBlock(root: string): string {
  try {
    if (!fs.existsSync(root)) return ""
    const tree = readTree(NEMO_SURFACE, root)
    const body = Object.keys(tree).length > 0 ? renderHarness(tree).block.trim() : ""
    const lessons = loadLessons(root)
    if (body.length === 0 && lessons.length === 0) return ""

    const parts = [
      "# ADOPTED HARNESS",
      "Learned automatically from earlier sessions in this workspace. Follow it unless the user says otherwise.",
    ]
    if (body.length > 0) parts.push(body.slice(0, MAX_HARNESS_CHARS))
    if (lessons.length > 0) {
      parts.push("# LESSONS FROM PRIOR RUNS", lessons)
    }
    return parts.join("\n\n")
  } catch {
    return ""
  }
}

/**
 * The newest lesson indexes, trimmed.
 *
 * Each area keeps one `library/<mode>/<area>/INDEX.md`; the most recently
 * written files describe the work this workspace actually does.
 */
function loadLessons(root: string): string {
  const libraryRoot = join(root, "library")
  if (!fs.existsSync(libraryRoot)) return ""
  const indexes: Array<{ file: string; at: number }> = []
  for (const mode of readdir(libraryRoot)) {
    const modeDir = join(libraryRoot, mode)
    for (const area of readdir(modeDir)) {
      const file = join(modeDir, area, "INDEX.md")
      try {
        const stat = fs.statSync(file)
        if (stat.isFile()) indexes.push({ file, at: stat.mtimeMs })
      } catch {
        /* no index for this area yet */
      }
    }
  }
  indexes.sort((a, b) => b.at - a.at)
  const chunks: string[] = []
  let used = 0
  for (const index of indexes.slice(0, 2)) {
    try {
      const body = fs.readFileSync(index.file, "utf8").trim()
      if (body.length === 0) continue
      const room = MAX_LESSON_CHARS - used
      if (room <= 0) break
      chunks.push(body.slice(0, room))
      used += Math.min(body.length, room)
    } catch {
      /* unreadable index: skip it */
    }
  }
  return chunks.join("\n\n")
}

function readdir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort()
  } catch {
    return []
  }
}

/** Test hook: the next read must hit disk. */
export function resetImprovedHarnessCacheForTests(): void {
  cache.clear()
}

/** The session's own harness context plus what earlier sessions learned. */
export function composeHarnessBlock(
  session: string | undefined,
  home: string = homedir(),
): string | undefined {
  const learned = loadImprovedHarnessBlock(home)
  const parts = [session?.trim(), learned].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  )
  return parts.length > 0 ? parts.join("\n\n") : undefined
}
