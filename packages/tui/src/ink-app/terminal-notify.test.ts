/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, it, expect, afterEach } from "vitest"
import { buildTerminalTitle, notifyTerminalActivity } from "./terminal-notify.js"

describe("buildTerminalTitle", () => {
  it("marks idle with no suffix", () => {
    expect(buildTerminalTitle({ activity: "idle" })).toBe("trayambak CLI")
  })

  it("describes working state", () => {
    expect(buildTerminalTitle({ activity: "working" })).toBe("* trayambak CLI - working")
  })

  it("describes attention states", () => {
    expect(buildTerminalTitle({ activity: "approval" })).toBe("! trayambak CLI - approval needed")
    expect(buildTerminalTitle({ activity: "input" })).toBe("? trayambak CLI - input needed")
    expect(buildTerminalTitle({ activity: "error" })).toBe("! trayambak CLI - error")
    expect(buildTerminalTitle({ activity: "task-done" })).toBe("trayambak CLI - task finished")
  })

  it("appends background task counts with correct pluralization", () => {
    expect(buildTerminalTitle({ activity: "working", backgroundCount: 1 })).toBe(
      "* trayambak CLI (1 background) - working",
    )
    expect(buildTerminalTitle({ activity: "working", backgroundCount: 3 })).toBe(
      "* trayambak CLI (3 background) - working",
    )
    expect(buildTerminalTitle({ activity: "idle", backgroundCount: 0 })).toBe("trayambak CLI")
    expect(buildTerminalTitle({ activity: "idle", backgroundCount: undefined })).toBe("trayambak CLI")
  })

  it("stays pure ASCII so legacy codepage tabs never mojibake", () => {
    for (const activity of ["idle", "working", "approval", "input", "error", "task-done"] as const) {
      expect(buildTerminalTitle({ activity, backgroundCount: 2 })).toMatch(/^[\x20-\x7E]*$/)
    }
  })

  it("honours a custom app name", () => {
    expect(buildTerminalTitle({ activity: "idle" }, "custom")).toBe("custom")
  })

  it("never puts the detail text into the title (detail is OSD-only)", () => {
    const title = buildTerminalTitle({ activity: "approval" })
    expect(title).not.toContain("tool")
  })
})

describe("notifyTerminalActivity", () => {
  afterEach(() => {
    delete process.env.TRAYAMBAK_NO_NOTIFY
  })

  it("never throws when disabled via TRAYAMBAK_NO_NOTIFY=1", () => {
    process.env.TRAYAMBAK_NO_NOTIFY = "1"
    expect(() => notifyTerminalActivity({ activity: "error", detail: "boom" })).not.toThrow()
    expect(() => notifyTerminalActivity({ activity: "task-done" })).not.toThrow()
  })

  it("never throws when stdout is not a TTY", () => {
    // Vitest pipes stdout, so this exercises the isTTY gate; even if a local
    // run has a TTY the writes are best-effort and must not throw.
    expect(() => notifyTerminalActivity({ activity: "task-done", detail: "done" })).not.toThrow()
    expect(() => notifyTerminalActivity({ activity: "approval" })).not.toThrow()
  })
})
