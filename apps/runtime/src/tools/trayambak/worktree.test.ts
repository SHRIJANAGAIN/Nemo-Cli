/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
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
import { createEnterWorktreeTool, listWorktrees } from "./worktree.js"

const repos: string[] = []

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

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of repos.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

describe("trayambak__EnterWorktree (#78)", () => {
  it("runs git with a filtered env: the post-checkout hook never sees raw secrets", async () => {
    const repo = makeRepo()
    const marker = path.join(repo, "hook-env.txt").replace(/\\/g, "/")
    const hookPath = path.join(repo, ".git", "hooks", "post-checkout")
    fs.writeFileSync(hookPath, `#!/bin/sh\necho "SECRET=$ZZ_TRAYAMBAK_HOOK_SECRET" > "${marker}"\n`, "utf8")
    fs.chmodSync(hookPath, 0o755)
    vi.stubEnv("ZZ_TRAYAMBAK_HOOK_SECRET", "raw-env-leaked")

    const tool = createEnterWorktreeTool()
    const res = await tool.execute("t1", {}, undefined, undefined, { cwd: repo } as unknown as ToolContext)

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
})
