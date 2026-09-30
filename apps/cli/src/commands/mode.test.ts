/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"

import { modeCommand, type ModeName } from "./mode.js"

/**
 * `trayambak mode` is a pure string formatter today (the mode is sticky
 * "default"), so these assert the exact user-facing strings — including the
 * error paths, which are what the CLI prints when a user typos a mode.
 */

const KNOWN: ModeName[] = ["default", "plan", "architect", "code", "debug", "review"]

describe("modeCommand", () => {
  it("lists every mode as a bullet under the header", () => {
    expect(modeCommand({ action: "list" })).toBe("Available modes:\n" + KNOWN.map((m) => `  - ${m}`).join("\n"))
  })

  it("reports the current mode (sticky default)", () => {
    expect(modeCommand({ action: "current" })).toBe("Current mode: default")
  })

  it("accepts every known mode name", () => {
    for (const mode of KNOWN) {
      expect(modeCommand({ action: "set", mode })).toBe(`Mode set to: ${mode}`)
    }
  })

  it("requires a mode for the set action", () => {
    expect(modeCommand({ action: "set" })).toBe("Missing mode")
  })

  it("rejects an unknown mode and enumerates the valid ones", () => {
    const out = modeCommand({ action: "set", mode: "hacker" as unknown as ModeName })
    expect(out).toBe("Unknown mode: hacker. Available: default, plan, architect, code, debug, review")
  })

  it("falls through for an unrecognized action", () => {
    expect(modeCommand({ action: "sideways" as never })).toBe("Unknown mode action: sideways")
  })
})
