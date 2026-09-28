/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { execFile } from "child_process"
import * as fs from "fs"
import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext, type ToolResult, resolveConstrainedPath } from "../types.js"
import { sanitizeSingleLine, repairFrontmatterScalarFields, validateSkillFrontmatter } from "./skill-parser.js"

/**
 * Skills are automation snippets - the same idea as the `skills/` folders in
 * the reference agent repos. A Skill is a
 * Markdown file with YAML front-matter:
 *
 *   ---
 *   name: my-skill
 *   description: Summarize what the skill does for the agent.
 *   command: node  scripts/do-thing.mjs
 *   cwd: ./scripts          # optional; resolved against the session cwd
 *   timeout: 60             # optional seconds
 *   ---
 *   # My skill
 *   Free-form body executed as a comment / documentation for the skill.
 *
 * Files live in `~/.trayambak/skills` or `<config.skillsDir>`. Each loaded
 * skill becomes the tool `skill__<name>`.
 */

export interface SkillSpec {
  name: string
  description: string
  command: string
  cwd?: string
  timeout?: number
  body?: string
}

/** Walk caps: skills roots must never become a full-disk scan. */
const SKILL_MAX_DEPTH = 5
const SKILL_MAX_FILES = 500

const SKIPPED_SKILL_DIRS = new Set([
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

export function loadSkillsFromDir(dir: string): SkillSpec[] {
  if (!dir || !fs.existsSync(dir)) return []
  const out: SkillSpec[] = []
  const seen = new Set<string>()
  let fileCount = 0

  function walk(current: string, depth: number): void {
    if (depth > SKILL_MAX_DEPTH || fileCount >= SKILL_MAX_FILES) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(current, e.name)
      if (e.isDirectory()) {
        if (SKIPPED_SKILL_DIRS.has(e.name) || e.name.startsWith(".")) continue
        let st: fs.Stats | null = null
        try {
          st = fs.lstatSync(full)
        } catch {
          continue
        }
        if (!st.isDirectory() || st.isSymbolicLink()) continue // no symlink loops
        walk(full, depth + 1)
      } else if (e.isFile()) {
        // SKILL.md only (Kilo parity): README/CHANGELOG must never become tools.
        if (e.name !== "SKILL.md") continue
        fileCount++
        if (fileCount > SKILL_MAX_FILES) return
        try {
          const raw = fs.readFileSync(full, "utf8")
          const spec = parseSkillFile(raw, full)
          if (spec && !seen.has(spec.name)) {
            seen.add(spec.name)
            out.push(spec)
          }
        } catch {
          /* skip malformed skill */
        }
      }
    }
  }

  walk(dir, 0)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function parseSkillFile(raw: string, filename = ""): SkillSpec | null {
  const frontmatterRe = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/
  const m = raw.match(frontmatterRe)
  if (!m) return null

  let frontmatter = m[1]
  const repaired = repairFrontmatterScalarFields(frontmatter)
  if (repaired) frontmatter = repaired

  const parsed = parseFrontmatterLines(frontmatter)
  const body = m[2].trim()
  // Name fallback BEFORE validation: SKILL.md files usually omit `name`
  // (the parent directory IS the name) — validating first would drop
  // every such skill as "missing name".
  const base = path.basename(filename)
  const fallback =
    base.toLowerCase() === "skill.md" && path.dirname(filename) && path.dirname(filename) !== "."
      ? path.basename(path.dirname(filename))
      : path.basename(filename, path.extname(filename))
  const effective: { name?: string; description?: string; shortDescription?: string; model?: unknown } & Record<
    string,
    string
  > = { ...parsed, name: parsed.name ?? fallback }
  const validation = validateSkillFrontmatter(effective)
  if (validation) return null

  const timeoutRaw = effective.timeout !== undefined ? Number(effective.timeout) : undefined
  return {
    name: sanitizeSingleLine(effective.name ?? fallback),
    description: sanitizeSingleLine(effective.description ?? ""),
    command: sanitizeSingleLine(parsed.command ?? "").trim(),
    cwd: parsed.cwd,
    timeout:
      timeoutRaw !== undefined && Number.isFinite(timeoutRaw)
        ? Math.max(1, Math.min(600, Math.floor(timeoutRaw)))
        : undefined,
    body,
  }
}

function parseFrontmatterLines(frontmatter: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of frontmatter.split("\n")) {
    const kv = line.match(/^\s*([^:]+):\s*(.*?)\s*$/)
    if (!kv) continue
    const key = kv[1].trim()
    if (!key) continue
    let value = kv[2].replace(/^["']|["']$/g, "")
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (!(key in out)) out[key] = value
  }
  return out
}

export function createSkillTool(skill: SkillSpec): Tool {
  // Command-less skills (the whole repo fleet: Claude-style name +
  // description + body) are READ-ONLY doc tools: invoking returns the body
  // text for the model to follow. Only skills declaring `command` spawn a
  // process. This replaces the old `echo "<name> skill loaded"` stubs.
  if (!skill.command) {
    const definition: ToolDefinition = {
      timeoutMs: 30_000,
      name: `skill__${skill.name}`,
      description: `Read the '${skill.name}' skill guide: ${skill.description}`.trim(),
      parameters: { type: "object", required: [], properties: {} },
    }
    return {
      definition,
      async execute(): Promise<ToolResult> {
        const body = (skill.body ?? "").trim()
        return textResult(body ? `# ${skill.name}\n\n${body}` : `(skill '${skill.name}' has no body)`)
      },
    }
  }
  const definition: ToolDefinition = {
    timeoutMs: 30_000,
    name: `skill__${skill.name}`,
    description: `Run the automation skill '${skill.name}': ${skill.description}`,
    parameters: {
      type: "object",
      required: [],
      properties: {
        args: { type: "string", description: "Optional space-separated arguments passed to the skill command." },
      },
    },
  }
  return {
    definition,
    async execute(_id, args, signal, _update, context) {
      const ctx = context as ToolContext
      let base: string
      try {
        base = resolveConstrainedPath(path.resolve(ctx.cwd, skill.cwd ?? "."), ctx.cwd)
      } catch (err) {
        return textResult(
          `skill '${skill.name}': unsafe cwd (${err instanceof Error ? err.message : String(err)})`,
          /*isError*/ true,
        )
      }
      const toRun = `${skill.command}${typeof args.args === "string" && args.args ? " " + args.args : ""}`
      const shellParts = toRun.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [toRun]
      const prog = shellParts[0].replace(/^"|"$/g, "")
      const progArgs = shellParts.slice(1)
      const timeoutMs = (skill.timeout ?? 120) * 1000

      return new Promise((resolve) => {
        let child: ReturnType<typeof execFile> | null = null
        try {
          child = execFile(
            prog,
            progArgs,
            { cwd: base, env: process.env, windowsHide: true, timeout: timeoutMs, signal },
            (err, stdout, stderr) => {
              const combined = `${stdout}${stderr ? "\n" + stderr : ""}`.trim() || "(no output)"
              if (err && (err as NodeJS.ErrnoException).code !== "ETIMEDOUT") {
                resolve(textResult(`skill '${skill.name}' failed (${err.message}):\n${combined}`, /*isError*/ true))
              } else if (err) {
                resolve(
                  textResult(
                    `skill '${skill.name}' timed out after ${skill.timeout ?? 120}s.\n${combined}`,
                    /*isError*/ true,
                  ),
                )
              } else {
                resolve(textResult(`${combined}`))
              }
            },
          )
          // execFile's timeout only reports ETIMEDOUT — reap runaway
          // children like the bash tool does instead of leaking them.
          const killer = setTimeout(() => {
            try {
              if (child && child.exitCode === null) child.kill("SIGKILL")
            } catch {
              /* already gone */
            }
          }, timeoutMs + 5000)
          if (typeof killer.unref === "function") killer.unref()
          child.on("exit", () => clearTimeout(killer))
        } catch (err) {
          resolve(
            textResult(
              `skill '${skill.name}': cannot start (${err instanceof Error ? err.message : String(err)})`,
              /*isError*/ true,
            ),
          )
        }
      })
    },
  }
}

export function createSkillTools(dir: string): Tool[] {
  return loadSkillsFromDir(dir).map(createSkillTool)
}

export function buildSkillsBlock(skills: SkillSpec[]): string {
  if (!skills || skills.length === 0) return ""
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`)
  return ["Loaded Skills:", ...lines].join("\n")
}

export function buildSkillsMentionBlock(skills: SkillSpec[]): string {
  if (!skills || skills.length === 0) return ""
  const names = skills.map((s) => s.name).join(", ")
  return `Available skills: ${names}. Use skill__<name> to invoke a skill.`
}

export function skillDescriptionsForPrompt(skills: SkillSpec[]): string {
  if (!skills || skills.length === 0) return ""
  return skills.map((s) => `${s.name}: ${s.description}`).join("\n")
}

export type { SkillMetadata, SkillPolicy, SkillInterface, SkillDependencies, LoadedSkills } from "./skill-model.js"
export { sanitizeSingleLine, repairFrontmatterScalarFields, validateSkillFrontmatter } from "./skill-parser.js"
export { defaultSkillsDir } from "./skill-core.js"
export { collectExplicitSkillMentions, selectSkillsFromMentions, normalizeSkillPath } from "./skill-selection.js"
export { loadSkillsFromRoots, MemorySkillRootSnapshots } from "./skill-loading.js"
export type { SkillRootSnapshotCache } from "./skill-loading.js"
