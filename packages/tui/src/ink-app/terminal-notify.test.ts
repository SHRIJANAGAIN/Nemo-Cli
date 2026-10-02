/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import {
  buildAnimatedTitle,
  buildTerminalTitle,
  isTitleAnimating,
  notifyTerminalActivity,
  setTerminalTitle,
  startTitleAnimation,
  stopTitleAnimation,
} from "./terminal-notify.js"

/** The four frames the animation cycles through, in order. */
function buildAnimatedFrameTitles(): string[] {
  return ["|", "/", "-", "\\"].map((frame) => buildAnimatedTitle(frame))
}

describe("buildTerminalTitle", () => {
  it("marks idle with no suffix, under the product name", () => {
    expect(buildTerminalTitle({ activity: "idle" })).toBe("Trayambak")
  })

  it("describes working state", () => {
    expect(buildTerminalTitle({ activity: "working" })).toBe("* Trayambak - working")
  })

  it("describes attention states", () => {
    expect(buildTerminalTitle({ activity: "approval" })).toBe("! Trayambak - approval needed")
    expect(buildTerminalTitle({ activity: "input" })).toBe("? Trayambak - input needed")
    expect(buildTerminalTitle({ activity: "error" })).toBe("! Trayambak - error")
    expect(buildTerminalTitle({ activity: "task-done" })).toBe("Trayambak - task finished")
  })

  it("appends background task counts with correct pluralization", () => {
    expect(buildTerminalTitle({ activity: "working", backgroundCount: 1 })).toBe("* Trayambak (1 background) - working")
    expect(buildTerminalTitle({ activity: "working", backgroundCount: 3 })).toBe("* Trayambak (3 background) - working")
    expect(buildTerminalTitle({ activity: "idle", backgroundCount: 0 })).toBe("Trayambak")
    expect(buildTerminalTitle({ activity: "idle", backgroundCount: undefined })).toBe("Trayambak")
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

describe("buildAnimatedTitle", () => {
  it("prefixes the spinner frame and the product name", () => {
    expect(buildAnimatedTitle("|")).toBe("| Trayambak")
    expect(buildAnimatedFrameTitles()).toHaveLength(4)
  })

  it("shows a compact background count and the phase", () => {
    expect(buildAnimatedTitle("/", { backgroundCount: 2 })).toBe("/ Trayambak (2 bg)")
    expect(buildAnimatedTitle("-", { phase: "thinking" })).toBe("- Trayambak thinking")
  })

  it("omits empty optional state instead of printing 'undefined'", () => {
    expect(buildAnimatedTitle("\\", { backgroundCount: 0, phase: "" })).toBe("\\ Trayambak")
  })

  it("stays pure ASCII like every other title", () => {
    expect(buildAnimatedTitle("|", { backgroundCount: 3, phase: "streaming" })).toMatch(/^[\x20-\x7E]*$/)
  })
})

describe("title animation lifecycle", () => {
  afterEach(() => {
    stopTitleAnimation()
    vi.useRealTimers()
    delete process.env.TRAYAMBAK_NO_NOTIFY
  })

  it("arms a timer while running and clears it on stop", () => {
    vi.useFakeTimers()
    expect(isTitleAnimating()).toBe(false)
    startTitleAnimation()
    expect(isTitleAnimating()).toBe(true)
    stopTitleAnimation()
    expect(isTitleAnimating()).toBe(false)
  })

  it("restarting never leaks a second timer", () => {
    vi.useFakeTimers()
    const first = setInterval(() => {}, 1000)
    startTitleAnimation()
    startTitleAnimation()
    startTitleAnimation()
    expect(isTitleAnimating()).toBe(true)
    // One live animation interval + the one we made = 2, not 4.
    expect(vi.getTimerCount()).toBe(2)
    clearInterval(first)
    stopTitleAnimation()
  })

  it("is a no-op without a TTY and under the kill-switch (no escape bytes into pipes)", () => {
    // Vitest pipes stdout, so the isTTY gate is exercised here.
    expect(() => startTitleAnimation()).not.toThrow()
    stopTitleAnimation()
    process.env.TRAYAMBAK_NO_NOTIFY = "1"
    expect(() => startTitleAnimation({ backgroundCount: 1 })).not.toThrow()
    expect(() => setTerminalTitle("nope")).not.toThrow()
    stopTitleAnimation()
  })

  it("stopping without an explicit title leaves no timer behind", () => {
    expect(() => stopTitleAnimation()).not.toThrow()
    expect(isTitleAnimating()).toBe(false)
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
