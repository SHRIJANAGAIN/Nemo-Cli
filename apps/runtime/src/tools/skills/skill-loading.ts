/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as path from "path"
import type { LoadedSkillRoot, LoadedSkills, SkillMetadata } from "./skill-model.js"
import { walkSkillFiles, defaultSkillsDir } from "./skill-core.js"
import { parseSkillFile } from "./skills.js"

export interface SkillRootSnapshotCache {
  get(root: string): LoadedSkillRoot | undefined
  set(root: string, value: LoadedSkillRoot): void
}

export class MemorySkillRootSnapshots implements SkillRootSnapshotCache {
  constructor(private cache = new Map<string, LoadedSkillRoot>()) {}
  get(root: string): LoadedSkillRoot | undefined {
    return this.cache.get(root)
  }
  set(root: string, value: LoadedSkillRoot): void {
    this.cache.set(root, value)
  }
}

export function loadSkillRoot(dir: string, cache?: SkillRootSnapshotCache): LoadedSkillRoot {
  const resolved = path.resolve(dir)
  if (cache) {
    const cached = cache.get(resolved)
    if (cached) return cached
  }

  const skills: SkillMetadata[] = []
  const errors: Array<{ path: string; message: string }> = []

  if (!fs.existsSync(resolved)) {
    const result = { root: resolved, skills: [], errors: [{ path: resolved, message: "directory not found" }] }
    cache?.set(resolved, result)
    return result
  }

  const files = walkSkillFiles(resolved)
  for (const file of files) {
    try {
      const raw = fs.readFileSync(file, "utf8")
      // Full path, not basename: parseSkillFile's fallback for SKILL.md is
      // the PARENT DIRECTORY name — passing just the basename made every
      // nameless SKILL.md collapse to the literal name "SKILL".
      const spec = parseSkillFile(raw, file)
      if (spec) {
        skills.push({
          name: spec.name,
          description: spec.description,
          shortDescription: spec.description.slice(0, 120),
          pathToSkillsMd: file,
          scope: resolved === defaultSkillsDir() ? "local" : "project",
        })
      }
    } catch {
      errors.push({ path: file, message: "failed to read skill file" })
    }
  }

  const result = { root: resolved, skills, errors }
  cache?.set(resolved, result)
  return result
}

export function loadSkillsFromRoots(dirs: string[], cache?: SkillRootSnapshotCache): LoadedSkills {
  const allSkills: SkillMetadata[] = []
  const allErrors: Array<{ path: string; message: string }> = []

  for (const dir of dirs) {
    const result = loadSkillRoot(dir, cache)
    allSkills.push(...result.skills)
    allErrors.push(...result.errors)
  }

  return { skills: allSkills, errors: allErrors }
}

export function skillDescriptionsFromRoots(dirs: string[], cache?: SkillRootSnapshotCache): string {
  const { skills } = loadSkillsFromRoots(dirs, cache)
  if (skills.length === 0) return ""
  return skills.map((s) => `${s.name}: ${s.description}`).join("\n")
}

export function skillNamesFromRoots(dirs: string[], cache?: SkillRootSnapshotCache): string[] {
  const { skills } = loadSkillsFromRoots(dirs, cache)
  return skills.map((s) => s.name)
}
