/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { execFileSync, execSync } from "child_process"
import * as fs from "fs"
import { EXIT_ERROR, EXIT_USAGE } from "../command-registry.js"

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

/**
 * True when the cwd is inside a git working tree. Checked quietly (piped
 * stdio): the old code let git's `fatal: not a git repository` dump raw to
 * the user's stderr and then reported "No worktrees found" with exit 0, which
 * reads as success for "there is nothing here" instead of "this is not a repo".
 */
function insideGitRepo(): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore", timeout: 30_000 })
    return true
  } catch {
    return false
  }
}

export function listWorktrees(): WorktreeEntry[] {
  if (!insideGitRepo()) {
    throw new Error(`not a git repository: ${process.cwd()}`)
  }
  try {
    const output = execSync("git worktree list --porcelain", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
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
  } catch (error) {
    // Inside a repo, a failed listing is a failure, not an empty result —
    // returning [] here used to print "No worktrees found" with exit 0.
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error)
    throw new Error(`git worktree list failed: ${detail}`)
  }
}

export function worktreeCommand(options: WorktreeOptions): string {
  // Usage errors (bad input) exit 2, git/runtime failures exit 1, success
  // leaves the code alone — a bare string on stdout with exit 0 must never
  // again mean "something failed".
  const usage = (message: string): string => {
    process.exitCode = EXIT_USAGE
    return message
  }
  try {
    switch (options.action) {
      case "list": {
        const entries = listWorktrees()
        if (entries.length === 0) return "No worktrees found"
        return entries.map((e) => `${e.path} [${e.branch ?? "detached"}]`).join("\n")
      }
      case "create": {
        const targetPath = options.path ?? options.name
        if (!targetPath) return usage("Missing path or name")
        const branch = options.branch ?? options.name ?? `wt-${Date.now().toString(36)}`
        // argv, never a shell string: `git worktree add "${targetPath}"`
        // ran path/branch through cmd.exe/`sh`, so a value like
        // `x" & calc & "` executed arbitrary commands.
        execFileSync("git", ["worktree", "add", targetPath, "-b", branch], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 10 * 1024 * 1024,
          timeout: 60_000,
        })
        return `Created worktree at ${targetPath} on branch ${branch}`
      }
      case "remove": {
        if (!options.path) return usage("Missing path")
        execFileSync("git", ["worktree", "remove", options.path], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 10 * 1024 * 1024,
          timeout: 60_000,
        })
        return `Removed worktree at ${options.path}`
      }
      case "switch": {
        if (!options.path) return usage("Missing path")
        if (!fs.existsSync(options.path)) return usage(`Worktree path does not exist: ${options.path}`)
        process.chdir(options.path)
        return `Switched to worktree at ${options.path}`
      }
      default:
        return usage(`Unknown worktree action: ${options.action}`)
    }
  } catch (error) {
    process.exitCode = EXIT_ERROR
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error)
    return `Worktree error: ${message}`
  }
}
