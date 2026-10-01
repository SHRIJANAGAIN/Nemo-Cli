/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/** Piped-stdin plumbing for `exec` — pure, no real stdin (injected). */

import { describe, expect, it } from "vitest"
import { MAX_PIPED_STDIN_CHARS, combinePromptWithStdin, readPipedStdin } from "./exec.js"

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
