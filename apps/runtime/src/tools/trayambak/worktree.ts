/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
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

const enterDef: ToolDefinition = {
  timeoutMs: 30_000,
  name: "trayambak__EnterWorktree",
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
      const branch = args.branch ? String(args.branch) : "HEAD"
      try {
        await gitExec(["worktree", "add", "-b", name, branch], { cwd: ctx.cwd })
        const entries = await listWorktrees(ctx.cwd)
        const entry = entries.find((e) => e.branch === name)
        const worktreePath = entry?.path ?? path.join(ctx.cwd, name)
        return textResult(
          `Created worktree on branch '${name}' based on ${branch}.\nPath: ${worktreePath}\nTo switch: use the worktree switch command or chdir to this path.`,
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
  name: "trayambak__ExitWorktree",
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
      const targetPath = args.path ? String(args.path) : ctx.cwd

      try {
        if (action === "remove") {
          await gitExec(["worktree", "remove", targetPath], { cwd: ctx.cwd })
          return textResult(`Worktree removed at ${targetPath}.`)
        }
        // keep: just prune stale entries
        await gitExec(["worktree", "prune"], { cwd: ctx.cwd })
        return textResult(`Worktree kept. Current context: ${ctx.cwd}`)
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
