/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"

/**
 * Walk caps: skills roots must never become a full-disk scan. Shared by
 * BOTH walkers — loadSkillsFromDir (tools) and walkSkillFiles (mention
 * selection) — so a project with a huge node_modules can't turn skill
 * discovery into an unbounded crawl.
 */
export const SKILL_MAX_DEPTH = 5
export const SKILL_MAX_FILES = 500

export const SKIPPED_SKILL_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".next",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
])

export function defaultSkillsDir(): string {
  const projectSkills = path.join(process.cwd(), "skills")
  if (fs.existsSync(projectSkills)) return projectSkills
  const local = path.join(process.cwd(), ".nemo", "skills")
  if (fs.existsSync(local)) return local
  return path.join(os.homedir(), ".nemo", "skills")
}

/** Bundled skills shipped inside the install (dist/assets/skills in
 *  production, ./skills in a source checkout) — always present so skills
 *  never depend on cwd. Lowest precedence: user/project roots win name
 *  collisions. `startDir` is a test seam for the module directory (ESM has
 *  no __dirname). */
export function bundledSkillsDir(startDir?: string): string | null {
  const here = startDir ?? (typeof __dirname === "string" ? __dirname : "")
  if (!here) return null
  // skill-core lives 5 deep in both layouts:
  //   dist: <root>/dist/apps/runtime/src/tools/skills → up 5 = dist
  //   src:  <root>/apps/runtime/src/tools/skills → up 5 = repo root
  const candidates = [
    path.resolve(here, "..", "..", "..", "..", "..", "assets", "skills"),
    path.resolve(here, "..", "..", "..", "..", "..", "skills"),
  ]
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate
    } catch {
      /* keep looking */
    }
  }
  return null
}

export function walkSkillFiles(dir: string): string[] {
  const out: string[] = []
  function walk(current: string, depth: number): void {
    if (depth > SKILL_MAX_DEPTH || out.length >= SKILL_MAX_FILES) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= SKILL_MAX_FILES) return
      const full = path.join(current, e.name)
      if (e.isDirectory()) {
        // Same skip set as the tool walker: node_modules/.git/build noise
        // must never be read for skills, and a junction loop stops at the
        // depth cap instead of crawling forever.
        if (SKIPPED_SKILL_DIRS.has(e.name) || e.name.startsWith(".")) continue
        let st: fs.Stats | null = null
        try {
          st = fs.lstatSync(full)
        } catch {
          continue
        }
        if (!st.isDirectory() || st.isSymbolicLink()) continue
        walk(full, depth + 1)
      } else if (e.isFile()) {
        const isSkillFile = e.name === "SKILL.md" || e.name.endsWith(".md")
        if (isSkillFile) out.push(full)
      }
    }
  }
  walk(dir, 0)
  return out
}
