/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { execSync } from "child_process"
import * as fs from "fs"

export interface WorktreeOptions {
  readonly action: "list" | "create" | "remove" | "switch"
  readonly path?: string
  readonly branch?: string
  readonly name?: string
}

export interface WorktreeEntry {
  path: string
  branch: string
  head?: string
}

export function listWorktrees(): WorktreeEntry[] {
  try {
    const output = execSync("git worktree list --porcelain", {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })
    const entries: WorktreeEntry[] = []
    let current: Partial<WorktreeEntry> = {}
    for (const line of output.split("\n")) {
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

export function worktreeCommand(options: WorktreeOptions): string {
  try {
    switch (options.action) {
      case "list": {
        const entries = listWorktrees()
        if (entries.length === 0) return "No worktrees found"
        return entries.map((e) => `${e.path} [${e.branch ?? "detached"}]`).join("\n")
      }
      case "create": {
        const targetPath = options.path ?? options.name
        if (!targetPath) return "Missing path or name"
        const branch = options.branch ?? options.name ?? `wt-${Date.now().toString(36)}`
        execSync(`git worktree add "${targetPath}" -b "${branch}"`, {
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
          timeout: 60_000,
        })
        return `Created worktree at ${targetPath} on branch ${branch}`
      }
      case "remove": {
        if (!options.path) return "Missing path"
        execSync(`git worktree remove "${options.path}"`, {
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
          timeout: 60_000,
        })
        return `Removed worktree at ${options.path}`
      }
      case "switch": {
        if (!options.path) return "Missing path"
        if (!fs.existsSync(options.path)) return `Worktree path does not exist: ${options.path}`
        process.chdir(options.path)
        return `Switched to worktree at ${options.path}`
      }
      default:
        return `Unknown worktree action: ${options.action}`
    }
  } catch (error) {
    return `Worktree error: ${error instanceof Error ? error.message : String(error)}`
  }
}
