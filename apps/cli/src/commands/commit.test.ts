/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import type { AgentMessage } from "../../../../packages/protocol/src/index.js"
import { buildCommitPrompt, COMMIT_DIFF_CAP, commitCommand, getStagedDiff, pickFinalText } from "./commit.js"

describe("buildCommitPrompt", () => {
  it("carries the diff with conventional-commit rules and nothing else", () => {
    const prompt = buildCommitPrompt("diff --git a/x b/x")

    expect(prompt).toContain("conventional-commit")
    expect(prompt).toContain("Output ONLY the message")
    expect(prompt).toContain("diff --git a/x b/x")
  })
})

describe("getStagedDiff", () => {
  it("returns the staged diff by default", async () => {
    const seen: string[][] = []
    const got = await getStagedDiff("staged", "/repo", async (args) => {
      seen.push(args)
      return "diff --git ok"
    })

    expect(got).toEqual({ ok: true, diff: "diff --git ok" })
    expect(seen).toEqual([["diff", "--staged", "--", "."]])
  })

  it("reads the working tree in --all mode", async () => {
    const got = await getStagedDiff("all", "/repo", async () => "unstaged")

    expect(got).toEqual({ ok: true, diff: "unstaged" })
  })

  it("caps a huge diff with a truncation marker", async () => {
    const got = await getStagedDiff("staged", "/repo", async () => "x".repeat(COMMIT_DIFF_CAP + 10))

    expect(got.ok).toBe(true)
    if (got.ok) {
      expect(got.diff.length).toBeLessThanOrEqual(COMMIT_DIFF_CAP + 25)
      expect(got.diff).toContain("[diff truncated]")
    }
  })

  it("errors loudly on empty diffs and git failures", async () => {
    expect(await getStagedDiff("staged", "/repo", async () => "  \n")).toEqual({
      ok: false,
      error: "nothing staged (git add first, or use --all)",
    })
    expect(await getStagedDiff("all", "/repo", async () => "")).toEqual({
      ok: false,
      error: "no working-tree changes",
    })
    expect(await getStagedDiff("staged", "/repo", async () => Promise.reject(new Error("no git")))).toEqual({
      ok: false,
      error: "git diff failed: no git",
    })
  })

  it("translates raw git dumps into one honest line (finding #30)", async () => {
    const usageDump = Object.assign(new Error("Command failed"), {
      stderr: "unknown option `staged'\nusage: git diff [--no-index] ...\n  200 more lines...",
    })
    expect(await getStagedDiff("staged", "/repo", async () => Promise.reject(usageDump))).toEqual({
      ok: false,
      error: "git diff failed: unknown option `staged'",
    })

    const notRepo = Object.assign(new Error("Command failed"), {
      stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
    })
    expect(await getStagedDiff("all", "/elsewhere", async () => Promise.reject(notRepo))).toEqual({
      ok: false,
      error: "not a git repository — run inside one or pass --cwd <repo>",
    })
  })
})

describe("pickFinalText", () => {
  it("returns the last assistant text", () => {
    const messages = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "text", text: "first" }], stopReason: "end_turn" },
      { role: "assistant", content: [{ type: "toolCall", id: "c", name: "x", arguments: {} }], stopReason: "tool_use" },
      { role: "assistant", content: [{ type: "text", text: "  feat(core): add thing  " }], stopReason: "end_turn" },
    ] as unknown as AgentMessage[]

    expect(pickFinalText(messages)).toBe("feat(core): add thing")
  })

  it("returns empty when no assistant text exists", () => {
    expect(pickFinalText([{ role: "user", content: "go" }] as unknown as AgentMessage[])).toBe("")
  })
})

describe("commitCommand", () => {
  it("drafts the message through the agent on a non-empty diff", async () => {
    const prompts: string[] = []
    const out = await commitCommand(
      { mode: "staged", cwd: "/repo" },
      {
        runDiff: async () => "diff --git a/x b/x",
        runAgent: async (prompt) => {
          prompts.push(prompt)
          return [
            {
              role: "assistant",
              content: [{ type: "text", text: "fix(cli): draft commit message" }],
              stopReason: "end_turn",
            },
          ] as unknown as AgentMessage[]
        },
      },
    )

    expect(out).toBe("fix(cli): draft commit message")
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("diff --git a/x b/x")
  })

  it("never calls the model when the diff is empty", async () => {
    let called = 0
    const out = await commitCommand(
      { mode: "staged", cwd: "/repo" },
      {
        runDiff: async () => "",
        runAgent: async () => {
          called += 1
          return []
        },
      },
    )

    expect(out).toContain("Error: nothing staged")
    expect(called).toBe(0)
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
  })

  it("says so when the agent returns no text", async () => {
    const out = await commitCommand(
      { mode: "all", cwd: "/repo" },
      { runDiff: async () => "some diff", runAgent: async () => [] },
    )

    expect(out).toContain("Error: the agent produced no commit message")
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
  })
})
