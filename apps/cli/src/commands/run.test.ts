/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * `run` headless fallback: piped output cannot host the Ink REPL (spawning
 * it there exits 0 having printed nothing — the audit's `run` no-op), so
 * those runs go through headless exec instead. `exec` is mocked: no model,
 * no processes, no stdin reads (a real fd-0 read would block the worker).
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand, shouldRunHeadless } from "./run.js"

const execCtl = vi.hoisted(() => ({
  calls: [] as Array<{ prompt: string; opts: unknown }>,
  reset(): void {
    execCtl.calls.length = 0
  },
}))

vi.mock("./exec.js", () => ({
  execCommand: async (prompt: string, opts: unknown) => {
    execCtl.calls.push({ prompt, opts })
  },
}))

describe("shouldRunHeadless", () => {
  it("is headless unless both streams are TTYs", () => {
    expect(shouldRunHeadless(true, true)).toBe(false)
    expect(shouldRunHeadless(false, true)).toBe(true)
    expect(shouldRunHeadless(true, false)).toBe(true)
    expect(shouldRunHeadless(undefined, undefined)).toBe(true)
  })
})

describe("runCommand headless fallback", () => {
  beforeEach(() => {
    execCtl.reset()
  })

  it("delegates the prompt to headless exec instead of spawning Ink when piped", async () => {
    // Vitest workers are piped (no TTY), so this takes the fallback path.
    await runCommand({ config: {} as never, prompt: "Reply OK" })
    expect(execCtl.calls).toEqual([{ prompt: "Reply OK", opts: { sessionFile: undefined } }])
  })

  it("carries sessionFile through to headless exec", async () => {
    await runCommand({ config: {} as never, prompt: "hi", sessionFile: "s.json" })
    expect(execCtl.calls).toEqual([{ prompt: "hi", opts: { sessionFile: "s.json" } }])
  })

  it("honours an explicit useInk=false", async () => {
    await runCommand({ config: {} as never, prompt: "hi", useInk: false })
    expect(execCtl.calls).toHaveLength(1)
  })
})
