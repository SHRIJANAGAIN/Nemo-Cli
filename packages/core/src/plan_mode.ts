/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Plan mode — read-only planning with plan files and approved commands.
 *
 * In plan mode the agent explores and writes a step-by-step plan instead
 * of mutating the workspace. Only tools in READ_ONLY_TOOLS may run;
 * everything else is denied. Plans persist as markdown files under
 * `.nemo/plans/` so they survive restarts and can be approved.
 *
 * Approved-command matching (#71): a prefix rule approves argv tail only —
 * if the tail contains shell control characters (`;`, `&`, `|`, `` ` ``,
 * `$`, `<`, `>`, parentheses, newlines), the command is NOT approved. An
 * exact rule match is always approved (the user typed that literal rule).
 */

import * as fs from "fs"
import * as path from "path"

/** Tools that may run in plan mode (pure reads + questions). */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_dir",
  "grep",
  "glob",
  "code_search",
  "read_manifest",
  "AskUserQuestion",
  "TodoRead",
])

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name)
}

/** Filter a tool-name list down to plan-mode-safe tools. */
export function filterToReadOnly(names: string[]): string[] {
  return names.filter((n) => isReadOnlyTool(n))
}

export interface PlanFile {
  name: string
  path: string
  content: string
  updatedAt: number
}

function plansDir(cwd: string): string {
  return path.join(cwd, ".nemo", "plans")
}

function planPath(cwd: string, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "plan"
  return path.join(plansDir(cwd), `${safe}.md`)
}

/** Persist a plan file (atomic write, 0600). Returns the stored record. */
export function writePlanFile(cwd: string, name: string, content: string): PlanFile {
  const file = planPath(cwd, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 })
  try {
    fs.chmodSync(tmp, 0o600)
  } catch {
    /* non-POSIX */
  }
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* best effort on Windows */
  }
  return { name, path: file, content, updatedAt: Date.now() }
}

export function readPlanFile(cwd: string, name: string): PlanFile | null {
  try {
    const file = planPath(cwd, name)
    if (!fs.existsSync(file)) return null
    const stat = fs.statSync(file)
    return { name, path: file, content: fs.readFileSync(file, "utf8"), updatedAt: stat.mtimeMs }
  } catch {
    return null
  }
}

export function listPlanFiles(cwd: string): string[] {
  try {
    const dir = plansDir(cwd)
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort()
  } catch {
    return []
  }
}

/** Shell control characters that must never appear in the un-approved tail
 *  of a prefix match (#71): `npm test ; rm -rf ~` starts with the approved
 *  `npm test ` prefix but runs a second command. Exact matches are exempt —
 *  a rule is the literal string the user approved. */
const UNSAFE_IN_APPROVED_TAIL = /[;&|$<>()`\n\r]/

/**
 * Approved-command check: exact/prefix list the user blessed for this plan
 * (e.g. after reviewing it). Empty list approves nothing. Prefix matches
 * only approve plain argv tail — anything with shell control characters
 * after the rule is rejected (#71).
 */
export function isApprovedCommand(command: string, approved: string[]): boolean {
  const cmd = command.trim()
  return approved.some((a) => {
    const rule = a.trim()
    if (!rule) return false
    if (cmd === rule) return true
    if (!cmd.startsWith(`${rule} `)) return false
    // Everything after `<rule> ` must be plain argv material: no
    // separators, pipes, substitutions, redirections, or subshells.
    return !UNSAFE_IN_APPROVED_TAIL.test(cmd.slice(rule.length + 1))
  })
}
