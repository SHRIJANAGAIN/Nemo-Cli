/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { gitExec } from "../../git_exec.js"
import { textResult, type Tool, type ToolContext } from "../types.js"

export interface WorktreeEntry {
  path: string
  branch: string
  head: string
}

export async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  try {
    const { stdout } = await gitExec(["worktree", "list", "--porcelain"], { cwd })
    const entries: WorktreeEntry[] = []
    let current: Partial<WorktreeEntry> = {}
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        current = { path: line.slice("worktree ".length).trim() }
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice("branch ".length).trim().replace("refs/heads/", "")
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice("HEAD ".length).trim()
      } else if (line.trim() === "") {
        if (current.path) entries.push(current as WorktreeEntry)
        current = {}
      }
    }
    if (current.path) entries.push(current as WorktreeEntry)
    return entries
  } catch {
    return []
  }
}

/** The worktree root that contains `cwd` (a linked worktree, or the repo). */
async function toplevelOf(cwd: string): Promise<string> {
  const { stdout } = await gitExec(["rev-parse", "--show-toplevel"], { cwd })
  return stdout.trim()
}

/** Path compare that survives git's forward slashes and Windows' case rules. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const resolved = path.resolve(p).replace(/[\\/]+$/, "")
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
  return norm(a) === norm(b)
}

/** Does the branch already exist? `show-ref --quiet` exits 1 when it does not. */
async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await gitExec(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoRoot })
    return true
  } catch {
    return false
  }
}

const enterDef: ToolDefinition = {
  timeoutMs: 30_000,
  name: "nemo__EnterWorktree",
  description:
    "Create an isolated git worktree for parallel work. Requires explicit user request or project memory instruction.",
  parameters: {
    type: "object",
    required: [],
    properties: {
      name: { type: "string", description: "Optional name for the new worktree." },
      branch: { type: "string", description: "Branch to base from. Default: current HEAD." },
    },
  },
}

export function createEnterWorktreeTool(): Tool {
  return {
    definition: enterDef,
    async execute(_id, args, _signal, _update, context) {
      const ctx = context as ToolContext
      const name = args.name ? String(args.name) : `wt-${Date.now().toString(36)}`
      const requested = args.branch ? String(args.branch) : "HEAD"
      if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
        return textResult(`Invalid worktree name '${name}': use a single directory name.`, /*isError*/ true)
      }
      // A branch cannot be created from itself.
      const startPoint = requested === name ? "HEAD" : requested
      try {
        const repoRoot = await toplevelOf(ctx.cwd)
        // Worktrees live BESIDE the repo, not inside it: a worktree under
        // the working tree would show up as untracked content and be walked
        // by every search tool.
        const worktreePath = path.join(path.dirname(repoRoot), name)
        // `git worktree add [-b <new-branch>] <path> [<commit-ish>]` — the
        // PATH comes first. Passing the start point in the path slot made
        // git create a worktree literally named "HEAD" in the repo root.
        const exists = await branchExists(repoRoot, name)
        const argv = exists
          ? ["worktree", "add", worktreePath, startPoint]
          : ["worktree", "add", "-b", name, worktreePath, startPoint]
        await gitExec(argv, { cwd: ctx.cwd })
        const entries = await listWorktrees(ctx.cwd)
        const entry = entries.find((e) => samePath(e.path, worktreePath))
        const created = entry?.path ?? worktreePath
        return textResult(
          `Created worktree on branch '${name}' based on ${startPoint}.\nPath: ${created}\nTo switch: use the worktree switch command or chdir to this path.`,
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return textResult(`Failed to create worktree: ${message}`, /*isError*/ true)
      }
    },
  }
}

const exitDef: ToolDefinition = {
  timeoutMs: 30_000,
  name: "nemo__ExitWorktree",
  description: "Exit a worktree session and return to the original directory.",
  parameters: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: ["keep", "remove"],
        description: "keep: leave on disk; remove: delete worktree.",
      },
      path: { type: "string", description: "Optional worktree path to exit from." },
    },
  },
}

export function createExitWorktreeTool(): Tool {
  return {
    definition: exitDef,
    async execute(_id, args, _signal, _update, context) {
      const ctx = context as ToolContext
      const action = String(args.action ?? "keep")
      try {
        const entries = await listWorktrees(ctx.cwd)
        if (entries.length === 0) {
          return textResult("Not a git repository — there is no worktree to exit.", /*isError*/ true)
        }
        // git lists the main worktree first; linked worktrees follow.
        const main = entries[0]
        let targetPath = args.path ? String(args.path) : ""
        if (!targetPath) {
          const here = await toplevelOf(ctx.cwd)
          const match = entries.find((e) => samePath(e.path, here))
          if (!match || samePath(match.path, main.path)) {
            // Falling back to the repo root would hand `git worktree remove`
            // the MAIN working tree, which git refuses to remove.
            return textResult(
              `Not inside a linked worktree (current: ${main.path}). Pass the worktree path as 'path' to act on it.`,
              /*isError*/ true,
            )
          }
          targetPath = match.path
        }
        if (action === "remove") {
          // Removal runs from the main worktree: git refuses to remove the
          // worktree the command is running inside.
          await gitExec(["worktree", "remove", targetPath], { cwd: main.path })
          return textResult(`Worktree removed at ${targetPath}. Return to ${main.path}.`)
        }
        await gitExec(["worktree", "prune"], { cwd: main.path })
        return textResult(`Worktree kept at ${targetPath}. Current context: ${ctx.cwd}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return textResult(`Worktree action failed: ${message}`, /*isError*/ true)
      }
    },
  }
}

export function switchWorktree(targetPath: string, originalCwd: string): { ok: boolean; message: string } {
  try {
    if (!fs.existsSync(targetPath)) {
      return { ok: false, message: `Worktree path does not exist: ${targetPath}` }
    }
    process.chdir(targetPath)
    return { ok: true, message: `Switched to worktree at ${targetPath}. Original cwd was ${originalCwd}.` }
  } catch (err) {
    return { ok: false, message: `Switch failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
