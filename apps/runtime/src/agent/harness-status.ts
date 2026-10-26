/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * What the autonomous harness has learned, for the UI.
 *
 * Pure filesystem reading with a short cache: the welcome screen asks on every
 * boot, and the TUI must never block or throw because a library entry is
 * half-written by a detached run that is still finishing.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export interface HarnessStatus {
  /** Lessons stored under `library/<mode>/<domain>/harnesses/`. */
  lessons: number
  /** mtime of the active harness tree — when the last harness was adopted. */
  adoptedAt?: number
  /** Queued session-end jobs (a run is pending or in flight). */
  pending: number
  /** mtime of `auto.log` — last unattended run. */
  lastAutoAt?: number
  /** Short cue of the newest lesson, for "what it learned". */
  lastLesson?: string
}

export function harnessRoot(home: string = os.homedir()): string {
  return path.join(home, ".nemo", "harness")
}

const CACHE_TTL_MS = 5_000
const cache = new Map<string, { at: number; status: HarnessStatus }>()

/** Test hook. */
export function resetHarnessStatusCacheForTests(): void {
  cache.clear()
}

/** A job file older than this is a dead child (crash, reboot), not work in
 *  flight — it must not make the UI claim a run is still happening. */
export const PENDING_TTL_MS = 2 * 60 * 60 * 1000

const statSafe = (file: string): fs.Stats | undefined => {
  try {
    return fs.statSync(file)
  } catch {
    return undefined
  }
}

const listSafe = (dir: string): fs.Dirent[] => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** `index` of the newest file in a directory tree, without following links. */
function newestExperience(library: string): { at: number; file: string } | undefined {
  let best: { at: number; file: string } | undefined
  for (const mode of listSafe(library)) {
    if (!mode.isDirectory()) continue
    const modeDir = path.join(library, mode.name)
    for (const domain of listSafe(modeDir)) {
      if (!domain.isDirectory()) continue
      const harnesses = path.join(modeDir, domain.name, "harnesses")
      for (const run of listSafe(harnesses)) {
        if (!run.isDirectory()) continue
        const file = path.join(harnesses, run.name, "EXPERIENCE.md")
        const stat = statSafe(file)
        if (stat && (!best || stat.mtimeMs > best.at)) best = { at: stat.mtimeMs, file }
      }
    }
  }
  return best
}

function countExperiences(library: string): number {
  let count = 0
  for (const mode of listSafe(library)) {
    if (!mode.isDirectory()) continue
    const modeDir = path.join(library, mode.name)
    for (const domain of listSafe(modeDir)) {
      if (!domain.isDirectory()) continue
      const harnesses = path.join(modeDir, domain.name, "harnesses")
      for (const run of listSafe(harnesses)) {
        if (run.isDirectory() && statSafe(path.join(harnesses, run.name, "EXPERIENCE.md"))) count += 1
      }
    }
  }
  return count
}

/** Pull `cue` out of EXPERIENCE.md (JSON written by HarnessLibrary, with an
 *  optional prose suffix — a plain JSON.parse would reject the suffix). */
export function lessonCue(text: string): string | undefined {
  const match = /"cue"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)
  if (!match) return undefined
  try {
    const cue = JSON.parse(`"${match[1]}"`) as string
    const trimmed = cue.replace(/\s+/g, " ").trim()
    return trimmed.length > 0 ? trimmed.slice(0, 72) : undefined
  } catch {
    return undefined
  }
}

export function readHarnessStatus(home: string = os.homedir(), now: number = Date.now()): HarnessStatus {
  const root = harnessRoot(home)
  const cached = cache.get(root)
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.status

  let status: HarnessStatus = { lessons: 0, pending: 0 }
  try {
    const library = path.join(root, "library")
    const lessons = countExperiences(library)
    let pending = 0
    const pendingDir = path.join(root, "pending")
    for (const entry of listSafe(pendingDir)) {
      if (!entry.name.endsWith(".json")) continue
      const stat = statSafe(path.join(pendingDir, entry.name))
      if (stat && now - stat.mtimeMs < PENDING_TTL_MS) pending += 1
    }
    const autoLog = statSafe(path.join(root, "auto.log"))
    const adopted = lessons > 0 ? statSafe(root) : undefined
    const newest = newestExperience(library)
    let lastLesson: string | undefined
    if (newest) {
      try {
        lastLesson = lessonCue(fs.readFileSync(newest.file, "utf8"))
      } catch {
        lastLesson = undefined
      }
    }
    status = {
      lessons,
      pending,
      ...(adopted ? { adoptedAt: adopted.mtimeMs } : {}),
      ...(autoLog ? { lastAutoAt: autoLog.mtimeMs } : {}),
      ...(lastLesson ? { lastLesson } : {}),
    }
  } catch {
    /* unreadable home: render the armed/empty state instead of failing boot */
  }

  cache.set(root, { at: now, status })
  return status
}
