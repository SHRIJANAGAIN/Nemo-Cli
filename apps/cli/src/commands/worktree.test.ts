/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { execSync } from "node:child_process"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { listWorktrees, worktreeCommand } from "./worktree.js"

/**
 * worktree.ts shells out to `git` with the process cwd as the repo, so each
 * test chdirs into a throwaway directory under os.tmpdir() (never a real
 * repository of the user). Argument validation and error paths are exercised
 * in a directory that is not a git repo at all; the create/list/remove
 * round-trip builds its own throwaway repository and is skipped when git is
 * unavailable.
 */

let originalCwd = ""
let tmp = ""
const dirs: string[] = []

function freshDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function gitAvailable(): boolean {
  try {
    execSync("git --version", { stdio: "ignore", timeout: 30_000 })
    return true
  } catch {
    return false
  }
}

beforeAll(() => {
  originalCwd = process.cwd()
})

afterEach(() => {
  process.chdir(originalCwd)
})

afterAll(() => {
  process.chdir(originalCwd)
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

beforeEach(() => {
  tmp = freshDir("nemo-worktree-")
  process.chdir(tmp)
  process.exitCode = undefined
})

afterEach(() => {
  process.exitCode = undefined
})

describe("worktreeCommand validation", () => {
  it("list outside a git repository says so plainly and fails (never silent exit 0)", () => {
    expect(worktreeCommand({ action: "list" })).toMatch(/^Worktree error: not a git repository: /)
    expect(process.exitCode).toBe(1)
    expect(() => listWorktrees()).toThrow(/not a git repository/)
  })

  it("create requires a path or name", () => {
    expect(worktreeCommand({ action: "create" })).toBe("Missing path or name")
  })

  it("remove requires a path", () => {
    expect(worktreeCommand({ action: "remove" })).toBe("Missing path")
  })

  it("switch requires a path", () => {
    expect(worktreeCommand({ action: "switch" })).toBe("Missing path")
  })

  it("switch rejects a path that does not exist", () => {
    const missing = path.join(tmp, "nope")

    expect(worktreeCommand({ action: "switch", path: missing })).toBe(`Worktree path does not exist: ${missing}`)
    expect(process.cwd()).toBe(tmp)
  })

  it("switch chdirs into an existing directory", () => {
    const target = freshDir("nemo-worktree-target-")

    expect(worktreeCommand({ action: "switch", path: target })).toBe(`Switched to worktree at ${target}`)
    expect(path.resolve(process.cwd())).toBe(path.resolve(target))
  })

  it("unknown action is reported", () => {
    expect(worktreeCommand({ action: "bogus" as never })).toBe("Unknown worktree action: bogus")
  })

  it("usage errors exit 2, git failures exit 1", () => {
    expect(worktreeCommand({ action: "create" })).toBe("Missing path or name")
    expect(process.exitCode).toBe(2)
    expect(worktreeCommand({ action: "remove" })).toBe("Missing path")
    expect(process.exitCode).toBe(2)
    expect(worktreeCommand({ action: "bogus" as never })).toBe("Unknown worktree action: bogus")
    expect(process.exitCode).toBe(2)
    // Outside a repo, create fails at git (not at validation).
    expect(worktreeCommand({ action: "create", path: path.join(tmp, "wt") })).toMatch(/^Worktree error: /)
    expect(process.exitCode).toBe(1)
  })
})

describe("worktreeCommand error path", () => {
  it("wraps git failures for create outside a repository", () => {
    const out = worktreeCommand({ action: "create", path: path.join(tmp, "wt") })

    expect(out.startsWith("Worktree error: ")).toBe(true)
    expect(fs.existsSync(path.join(tmp, "wt"))).toBe(false)
  })

  it("wraps git failures for remove outside a repository", () => {
    expect(worktreeCommand({ action: "remove", path: path.join(tmp, "wt") })).toMatch(/^Worktree error: /)
  })
})

describe("worktreeCommand with a real repository", () => {
  it("creates, lists and removes a worktree", ({ skip }) => {
    if (!gitAvailable()) return skip()

    const repo = freshDir("nemo-worktree-repo-")
    execSync("git init -q", { cwd: repo, stdio: "ignore", timeout: 30_000 })
    execSync(
      "git -c commit.gpgsign=false -c user.email=test@example.com -c user.name=test commit -q --allow-empty -m init",
      { cwd: repo, stdio: "ignore", timeout: 30_000 },
    )
    process.chdir(repo)

    const wtPath = path.join(freshDir("nemo-worktree-sibling-"), "wt-clone")
    const created = worktreeCommand({ action: "create", path: wtPath, branch: "wt-feature" })

    expect(created).toBe(`Created worktree at ${wtPath} on branch wt-feature`)
    expect(fs.existsSync(wtPath)).toBe(true)

    const listed = worktreeCommand({ action: "list" })
    expect(listed.split("\n").length).toBe(2)
    // Git may print the worktree path with either separator; the leaf name
    // and the branch marker are stable across both.
    expect(listed).toContain("wt-clone")
    expect(listed).toContain("[wt-feature]")
    expect(listWorktrees().some((e) => e.branch === "wt-feature" && e.head)).toBe(true)

    expect(worktreeCommand({ action: "remove", path: wtPath })).toBe(`Removed worktree at ${wtPath}`)
    expect(fs.existsSync(wtPath)).toBe(false)
    expect(worktreeCommand({ action: "list" })).not.toContain("[wt-feature]")
  })

  it("defaults the branch name when only a path is given", ({ skip }) => {
    if (!gitAvailable()) return skip()

    const repo = freshDir("nemo-worktree-repo2-")
    execSync("git init -q", { cwd: repo, stdio: "ignore", timeout: 30_000 })
    execSync(
      "git -c commit.gpgsign=false -c user.email=test@example.com -c user.name=test commit -q --allow-empty -m init",
      { cwd: repo, stdio: "ignore", timeout: 30_000 },
    )
    process.chdir(repo)

    const wtPath = path.join(freshDir("nemo-worktree-sibling2-"), "wt-default")
    const created = worktreeCommand({ action: "create", path: wtPath })

    expect(created).toMatch(/^Created worktree at .+ on branch wt-[a-z0-9]+$/)
    expect(worktreeCommand({ action: "remove", path: wtPath })).toBe(`Removed worktree at ${wtPath}`)
  })
})

describe("worktreeCommand never reaches a shell (round 12 attack)", () => {
  it("passes metacharacter paths to git as literal argv — no command injection", () => {
    // Pre-fix, create/remove interpolated user input into execSync's shell
    // string: `git worktree add "${targetPath}"` turned
    //   x" & echo pwned > "<sentinel>" & REM "
    // into a second, arbitrary command (cmd.exe `&` / sh `;`). The sentinel
    // is the canary: it must never appear.
    const sentinel = path.join(tmp, "pwned.txt")
    const payload =
      process.platform === "win32"
        ? `x" & echo pwned > "${sentinel}" & REM "`
        : `x"; touch "${sentinel}"; : "`

    try {
      const out = worktreeCommand({ action: "create", path: payload, branch: "b1" })
      expect(out).toMatch(/^Worktree error:/)
      expect(process.exitCode).toBe(1)
      expect(fs.existsSync(sentinel)).toBe(false)

      const out2 = worktreeCommand({ action: "remove", path: payload })
      expect(out2).toMatch(/^Worktree error:/)
      expect(fs.existsSync(sentinel)).toBe(false)
    } finally {
      // If a future refactor re-introduces a shell, fail loudly but leave
      // no canary behind even when the assertion above already failed.
      try {
        fs.rmSync(sentinel, { force: true })
      } catch {
        /* best effort */
      }
    }
  })

  it("branch names are argv too — the same payload in -b never runs", () => {
    const sentinel = path.join(tmp, "pwned-branch.txt")
    const branch =
      process.platform === "win32"
        ? `b" & echo pwned > "${sentinel}" & REM "`
        : `b"; touch "${sentinel}"; : "`

    try {
      const out = worktreeCommand({ action: "create", path: path.join(tmp, "wt"), branch })
      expect(out).toMatch(/^Worktree error:/)
      expect(fs.existsSync(sentinel)).toBe(false)
    } finally {
      try {
        fs.rmSync(sentinel, { force: true })
      } catch {
        /* best effort */
      }
    }
  })
})
