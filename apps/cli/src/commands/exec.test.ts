/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/** Piped-stdin plumbing for `exec` — pure, no real stdin (injected). */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { MAX_PIPED_STDIN_CHARS, combinePromptWithStdin, execCommand, readPipedStdin } from "./exec.js"

const agentCtl = vi.hoisted(() => ({
  constructed: [] as Array<unknown>,
  prompts: [] as Array<string>,
  reset(): void {
    agentCtl.constructed.length = 0
    agentCtl.prompts.length = 0
  },
}))

vi.mock("../../../runtime/src/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../runtime/src/index.js")>()
  return {
    ...actual,
    Agent: class {
      constructor(opts: unknown) {
        agentCtl.constructed.push(opts)
      }
      async run(prompt: string): Promise<never[]> {
        agentCtl.prompts.push(prompt)
        return []
      }
    },
  }
})

describe("readPipedStdin", () => {
  it("reads piped stdin and undefined-isTTY contexts, never a TTY", () => {
    expect(readPipedStdin(false, () => "diff --git hello")).toBe("diff --git hello")
    // Windows pipes and spawned contexts report undefined — still readable.
    expect(readPipedStdin(undefined, () => "piped")).toBe("piped")
    expect(readPipedStdin(true, () => "must never be read")).toBe("")
  })

  it("never throws on unreadable stdin", () => {
    expect(
      readPipedStdin(false, () => {
        throw new Error("EBADF")
      }),
    ).toBe("")
  })
})

describe("combinePromptWithStdin", () => {
  it("passes the prompt through untouched without piped input", () => {
    expect(combinePromptWithStdin("review this", "")).toBe("review this")
    expect(combinePromptWithStdin("review this", "   \n  ")).toBe("review this")
  })

  it("appends piped context after the instruction", () => {
    const out = combinePromptWithStdin("review for bugs", "diff --git a/x")
    expect(out.startsWith("review for bugs\n\n[Piped stdin follows:]\n")).toBe(true)
    expect(out).toContain("diff --git a/x")
  })

  it("uses piped content alone when no prompt was given", () => {
    expect(combinePromptWithStdin("", "some context")).toBe("[Piped stdin follows:]\nsome context")
  })

  it("caps runaway pipes with a truncation marker", () => {
    const out = combinePromptWithStdin("p", `${"x".repeat(MAX_PIPED_STDIN_CHARS + 10)}`)
    expect(out.length).toBeLessThan(MAX_PIPED_STDIN_CHARS + 200)
    expect(out).toContain("…[piped stdin truncated]")
  })
})

describe("execCommand wiring", () => {
  let home = ""
  let tmp = ""
  let originalCwd = ""
  let savedHome: string | undefined
  let savedUserprofile: string | undefined

  beforeEach(() => {
    agentCtl.reset()
    originalCwd = process.cwd()
    home = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-exec-home-"))
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-exec-cwd-"))
    savedHome = process.env.HOME
    savedUserprofile = process.env.USERPROFILE
    process.env.HOME = home
    process.env.USERPROFILE = home
    process.chdir(tmp)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedUserprofile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = savedUserprofile
    for (const dir of [home, tmp]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  })

  it("combines prompt + piped stdin and carries sessionFile to the agent", async () => {
    await execCommand("review", { sessionFile: "s.json" }, { readStdin: () => "diff-context" })
    expect(agentCtl.constructed).toHaveLength(1)
    expect(agentCtl.constructed[0]).toMatchObject({ sessionFile: "s.json" })
    expect(agentCtl.prompts).toHaveLength(1)
    expect(agentCtl.prompts[0]).toContain("review")
    expect(agentCtl.prompts[0]).toContain("diff-context")
  })
})
