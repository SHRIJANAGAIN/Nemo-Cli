/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * gitExec (#78) — the child-process boundary for every git invocation.
 *
 * Both cases run a real repository with a real hook, because the threat is
 * repository-controlled code: a planted `.git/hooks/post-checkout` observes
 * exactly what the planted `pre-commit` observes here, and `git worktree
 * add` runs it (verified during the audit — it emitted the marker file).
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { gitExec } from "./git_exec.js"

const repos: string[] = []

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-exec-"))
  repos.push(dir)
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore", timeout: 15_000 })
  }
  run(["init", "-q", "."])
  run(["config", "user.email", "git-exec@example.com"])
  run(["config", "user.name", "git-exec"])
  // Hermetic: never sign, never consult an ambient hooksPath.
  run(["config", "commit.gpgsign", "false"])
  run(["config", "core.hooksPath", path.join(dir, ".git", "hooks")])
  fs.writeFileSync(path.join(dir, "a.txt"), "x", "utf8")
  run(["add", "a.txt"])
  run(["commit", "-q", "-m", "init"])
  return dir
}

/** BOM-less, LF-only sh hook (a UTF-8 BOM breaks the shebang). */
function writeHook(repo: string, name: string, body: string): void {
  const hookPath = path.join(repo, ".git", "hooks", name)
  fs.writeFileSync(hookPath, `#!/bin/sh\n${body}\n`, "utf8")
  fs.chmodSync(hookPath, 0o755)
}

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

describe("gitExec (#78)", () => {
  it("hands repo-controlled hooks a filtered env, never raw secrets", async () => {
    const repo = makeRepo()
    const marker = path.join(repo, "hook-env.txt").replace(/\\/g, "/")
    writeHook(repo, "pre-commit", `echo "SECRET=$ZZ_TRAYAMBAK_HOOK_SECRET" > "${marker}"`)
    vi.stubEnv("ZZ_TRAYAMBAK_HOOK_SECRET", "raw-env-leaked")

    await gitExec(["commit", "-q", "--allow-empty", "-m", "hook"], { cwd: repo })

    const content = fs.readFileSync(path.join(repo, "hook-env.txt"), "utf8")
    expect(content).toContain("SECRET=")
    expect(content).not.toContain("raw-env-leaked")
  })

  it("kills a hung git child at the deadline instead of orphaning it", async () => {
    const repo = makeRepo()
    writeHook(repo, "pre-commit", "sleep 3")

    const started = Date.now()
    await expect(gitExec(["commit", "--allow-empty", "-m", "hang"], { cwd: repo, timeoutMs: 400 })).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(2_500)
  })
})
