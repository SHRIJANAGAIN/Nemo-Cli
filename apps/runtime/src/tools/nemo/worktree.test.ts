/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Worktree tools (#78) — `git worktree add` executes the repository's
 * post-checkout hook, i.e. repository-controlled code (or a hook a
 * prompt-injected model just wrote into .git/hooks). That child must see
 * the filtered env exactly like the same command typed into `bash`.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { ToolContext, ToolResult } from "../types.js"
import { createEnterWorktreeTool, createExitWorktreeTool, listWorktrees } from "./worktree.js"

const repos: string[] = []
const worktrees: string[] = []

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-tool-"))
  repos.push(dir)
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore", timeout: 15_000 })
  }
  run(["init", "-q", "."])
  run(["config", "user.email", "wt@example.com"])
  run(["config", "user.name", "wt"])
  run(["config", "commit.gpgsign", "false"])
  run(["config", "core.hooksPath", path.join(dir, ".git", "hooks")])
  fs.writeFileSync(path.join(dir, "a.txt"), "x", "utf8")
  run(["add", "a.txt"])
  run(["commit", "-q", "-m", "init"])
  return dir
}

const textOf = (res: ToolResult): string => res.content.map((c) => (c as { text?: string }).text ?? "").join("\n")

const pathFrom = (res: ToolResult): string => /Path: (.+)/.exec(textOf(res))?.[1]?.trim() ?? ""

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of worktrees.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
  for (const dir of repos.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

describe("nemo__EnterWorktree (#78)", () => {
  it("runs git with a filtered env: the post-checkout hook never sees raw secrets", async () => {
    const repo = makeRepo()
    const marker = path.join(repo, "hook-env.txt").replace(/\\/g, "/")
    const hookPath = path.join(repo, ".git", "hooks", "post-checkout")
    fs.writeFileSync(hookPath, `#!/bin/sh\necho "SECRET=$ZZ_NEMO_HOOK_SECRET" > "${marker}"\n`, "utf8")
    fs.chmodSync(hookPath, 0o755)
    vi.stubEnv("ZZ_NEMO_HOOK_SECRET", "raw-env-leaked")

    const tool = createEnterWorktreeTool()
    const res = await tool.execute("t1", {}, undefined, undefined, { cwd: repo } as unknown as ToolContext)
    worktrees.push(pathFrom(res))

    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toContain("Created worktree")
    // The hook actually fired (post-checkout really runs on worktree add)…
    const content = fs.readFileSync(path.join(repo, "hook-env.txt"), "utf8")
    expect(content).toContain("SECRET=")
    // …and got the filtered env, not the CLI's raw secrets.
    expect(content).not.toContain("raw-env-leaked")

    const entries = await listWorktrees(repo)
    expect(entries.length).toBeGreaterThanOrEqual(2)
  })

  /**
   * `git worktree add [-b <branch>] <path> [<commit-ish>]` takes the PATH
   * first. The tool used to pass the start point in the path slot, so git
   * created a worktree literally named "HEAD" inside the repo — a
   * directory that looks like a file, in the middle of the working tree.
   */
  it("creates the worktree at a real path, not a directory named after the rev", async () => {
    const repo = makeRepo()
    const tool = createEnterWorktreeTool()
    const res = await tool.execute("t1", { name: "wt-named" }, undefined, undefined, { cwd: repo } as unknown as ToolContext)
    const created = pathFrom(res)
    worktrees.push(created)

    expect(res.isError).toBeFalsy()
    expect(created).not.toBe("")
    expect(fs.existsSync(created)).toBe(true)
    expect(fs.statSync(created).isDirectory()).toBe(true)
    // The repo content is actually checked out there.
    expect(fs.existsSync(path.join(created, "a.txt"))).toBe(true)
    // And the repo root holds no "HEAD" directory.
    expect(fs.existsSync(path.join(repo, "HEAD"))).toBe(false)
  })

  it("bases the new branch on the requested start point", async () => {
    const repo = makeRepo()
    const tool = createEnterWorktreeTool()
    const res = await tool.execute("t1", { name: "wt-base", branch: "HEAD" }, undefined, undefined, {
      cwd: repo,
    } as unknown as ToolContext)
    worktrees.push(pathFrom(res))

    expect(res.isError).toBeFalsy()
    const entries = await listWorktrees(repo)
    expect(entries.some((e) => e.branch === "wt-base")).toBe(true)
  })

  it("refuses a name that would escape the worktree parent", async () => {
    const repo = makeRepo()
    const tool = createEnterWorktreeTool()
    const res = await tool.execute("t1", { name: "../escape" }, undefined, undefined, { cwd: repo } as unknown as ToolContext)

    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain("Invalid worktree name")
  })
})

describe("nemo__ExitWorktree", () => {
  it("removes the worktree the caller is standing in", async () => {
    const repo = makeRepo()
    const enter = createEnterWorktreeTool()
    const res = await enter.execute("t1", { name: "wt-exit" }, undefined, undefined, { cwd: repo } as unknown as ToolContext)
    const created = pathFrom(res)
    worktrees.push(created)
    expect(fs.existsSync(created)).toBe(true)

    const exit = createExitWorktreeTool()
    // No 'path' given: the tool must find the worktree under the cwd
    // instead of handing git the repo root (the main working tree).
    const out = await exit.execute("t2", { action: "remove" }, undefined, undefined, {
      cwd: created,
    } as unknown as ToolContext)

    expect(out.isError).toBeFalsy()
    expect(textOf(out)).toContain("Worktree removed")
    expect(fs.existsSync(created)).toBe(false)
  })

  it("says so when the caller is in the main worktree, instead of removing the repo", async () => {
    const repo = makeRepo()
    const exit = createExitWorktreeTool()
    const out = await exit.execute("t1", { action: "remove" }, undefined, undefined, {
      cwd: repo,
    } as unknown as ToolContext)

    expect(out.isError).toBe(true)
    expect(textOf(out)).toContain("Not inside a linked worktree")
    expect(fs.existsSync(repo)).toBe(true)
  })

  it("keeps the worktree on disk", async () => {
    const repo = makeRepo()
    const enter = createEnterWorktreeTool()
    const res = await enter.execute("t1", { name: "wt-keep" }, undefined, undefined, { cwd: repo } as unknown as ToolContext)
    const created = pathFrom(res)
    worktrees.push(created)

    const exit = createExitWorktreeTool()
    const out = await exit.execute("t2", { action: "keep" }, undefined, undefined, {
      cwd: created,
    } as unknown as ToolContext)

    expect(out.isError).toBeFalsy()
    expect(fs.existsSync(created)).toBe(true)
  })
})
