/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The per-area experience library R: what earlier tasks in this area produced.
 *
 *     <root>/<area>/INDEX.md
 *     <root>/<area>/harnesses/<task>/harness/<rel>   the full adopted tree
 *     <root>/<area>/harnesses/<task>/EXPERIENCE.md   why picked + lesson
 *
 * `<area>` is the coding agent's domain: a language, an area of the codebase,
 * a stack. Retrieval is by construction: an area's directory only ever holds
 * same-area entries. The whole tree is carried, never a summary. Roots are
 * scoped per run and mode, so each sweep starts every area empty.
 *
 * An entry is only written when a real lesson came back. A harness without a
 * lesson is a copy of somebody's work with no explanation: the next task
 * cannot tell whether to trust it.
 *
 * Adapted from Harness² (Copyright 2026 Google LLC, Apache-2.0) — see
 * NOTICE.md in this directory.
 */

import * as fs from "fs"
import * as path from "path"
import type { HarnessLesson, HarnessTree } from "./types.js"
import type { SurfaceSpec } from "./tree.js"
import { assertTreeHasNoGraderVerdicts, safeName } from "./context.js"
import { inventory, readTree, walk, writeTree } from "./tree.js"

/** A flat, path-safe slug for a task id. */
export function slug(taskId: string): string {
  return taskId.replace(/[/\\]/g, "__")
}

/** Whether a lesson is durable: every load-bearing field is present and non-empty. */
export function hasExperience(experience: HarnessLesson | null | undefined): boolean {
  return (
    experience !== null &&
    typeof experience === "object" &&
    typeof experience.cue === "string" &&
    experience.cue.trim().length > 0 &&
    typeof experience.lesson === "string" &&
    experience.lesson.trim().length > 0 &&
    typeof experience.evidence === "string" &&
    experience.evidence.trim().length > 0
  )
}

/** One directory name for an area, never a path. */
export function domainDir(domain: string): string {
  const collapsed = domain.replace(/\s*[/\\]\s*/g, "__").trim()
  return collapsed.length > 0 ? collapsed : "unknown"
}

export interface LibraryAddInput {
  taskId: string
  harness: HarnessTree
  why?: string
  label?: string
  runId?: string
  experience?: HarnessLesson | null
}

/** One (run, area) library: read before each task, appended after. */
export class HarnessLibrary {
  readonly root: string
  readonly domain: string
  readonly surface: SurfaceSpec

  constructor(input: { root: string; domain: string; surface: SurfaceSpec }) {
    this.root = input.root
    this.domain = input.domain
    this.surface = input.surface
  }

  get dir(): string {
    return path.join(this.root, domainDir(this.domain))
  }

  get index(): string {
    return path.join(this.dir, "INDEX.md")
  }

  entryDir(taskId: string): string {
    return path.join(this.dir, "harnesses", slug(taskId))
  }

  exists(): boolean {
    return fs.existsSync(this.index)
  }

  /** The directory handed to an improver session, or null when this area is empty. */
  contextDir(): string | null {
    if (!this.exists() || !this.anyExperience()) return null
    return this.dir
  }

  entries(): string[] {
    const dir = path.join(this.dir, "harnesses")
    if (!isDirectory(dir)) return []
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  }

  treeOf(taskId: string): HarnessTree {
    return readTree(this.surface, path.join(this.entryDir(taskId), "harness"))
  }

  /** Drop the entries for these tasks and rebuild INDEX.md; unknown tasks are ignored. */
  forget(taskIds: readonly string[]): void {
    let removed = false
    for (const taskId of taskIds) {
      const dir = this.entryDir(taskId)
      if (isDirectory(dir)) {
        fs.rmSync(dir, { recursive: true, force: true })
        removed = true
      }
    }
    if (removed) this.rebuildIndex()
  }

  /** Keep only the entries preceding the current task in this stream. */
  retain(taskIds: readonly string[]): void {
    const keep = new Set(taskIds.map(slug))
    this.forget(this.entries().filter((entry) => !keep.has(entry)))
  }

  /**
   * Store one adopted harness plus why it was adopted, and rebuild INDEX.md
   * from disk. A tree is checked for grader verdicts before anything lands.
   */
  add(input: LibraryAddInput): string | null {
    const experience = input.experience ?? null
    if (!hasExperience(experience)) return null
    const lesson = experience as HarnessLesson
    assertTreeHasNoGraderVerdicts(input.harness)
    assertTreeHasNoGraderVerdicts({
      "EXPERIENCE.md": `${JSON.stringify(lesson)}${input.why ?? ""}`,
    })

    const dir = this.entryDir(input.taskId)
    fs.rmSync(path.join(dir, "harness"), { recursive: true, force: true })
    writeTree(this.surface, input.harness, path.join(dir, "harness"), { stubs: false })

    const lines = [
      `# ${input.taskId}`,
      "",
      `- adopted: \`${input.label ?? ""}\`${input.runId ? `  (run \`${input.runId}\`)` : ""}`,
      `- components: ${inventory(this.surface, input.harness)}`,
      "",
    ]
    if ((input.why ?? "").trim().length > 0) {
      lines.push("## Why this was chosen", (input.why ?? "").trim(), "")
    }
    if (lesson.edits.trim().length > 0) {
      lines.push("## What each edit did", lesson.edits.trim(), "")
    }
    if (lesson.lesson.trim().length > 0) {
      lines.push("## Transferable lesson")
      for (const field of ["cue", "lesson", "evidence", "confidence"] as const) {
        const value = lesson[field].trim()
        if (value.length > 0) lines.push(`- **${field}**: ${value}`)
      }
      lines.push("")
    }
    fs.writeFileSync(path.join(dir, "EXPERIENCE.md"), lines.join("\n"), "utf8")
    this.rebuildIndex()
    return dir
  }

  /** Regenerate INDEX.md from what is on disk. */
  rebuildIndex(): string {
    const rows = [
      `# Library — ${this.domain}`,
      "",
      "Each entry is an earlier task in THIS area whose harness was chosen, stored with its " +
        "FULL component tree and why it was picked. Browse this index, then open the entries " +
        "that look relevant to the matter in front of you.",
      "",
    ]
    const names = this.entries()
    if (names.length === 0) rows.push("_(empty — this is the first task in this area)_")
    for (const name of names) {
      const dir = path.join(this.dir, "harnesses", name)
      const cue = field(path.join(dir, "EXPERIENCE.md"), "cue")
      const lesson = field(path.join(dir, "EXPERIENCE.md"), "lesson")
      const tree = readTree(this.surface, path.join(dir, "harness"))
      rows.push(
        `## \`harnesses/${name}/\``,
        `- harness: \`harnesses/${name}/harness/\` — ${inventory(this.surface, tree)}`,
        `- why:     \`harnesses/${name}/EXPERIENCE.md\``,
      )
      if (cue.length > 0) rows.push(`- cue:     ${cue}`)
      if (lesson.length > 0) rows.push(`- lesson:  ${lesson}`)
      rows.push("")
    }
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(this.index, rows.join("\n"), "utf8")
    return this.index
  }

  private anyExperience(): boolean {
    for (const file of walk(this.dir)) {
      if (path.basename(file) === "EXPERIENCE.md") return true
    }
    return false
  }
}

/** A one-line census of the components actually in this harness. */
function field(file: string, name: string): string {
  let body: string
  try {
    body = fs.readFileSync(file, "utf8")
  } catch {
    return ""
  }
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith(`- **${name}**:`)) {
      const at = line.indexOf(":")
      return line.slice(at + 1).trim()
    }
  }
  return ""
}

/**
 * Per-run library root `<base>/<runTag>/<variant>`; an explicit `tag` opts
 * into sharing one library across runs.
 */
export function rootFor(
  base: string,
  input: { runTag: string; variant?: string; tag?: string },
): string {
  if (input.tag && input.tag.length > 0) return path.join(base, input.runTag, safeName(input.tag))
  const parts = [input.variant ?? ""].filter((part) => part.length > 0)
  return path.join(base, input.runTag, ...(parts.length > 0 ? parts : ["default"]))
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}
