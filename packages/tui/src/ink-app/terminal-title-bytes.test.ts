/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Byte-level proof that the terminal title is really emitted as an OSC 0
 * sequence (and not merely computed correctly).
 *
 * The unit tests in terminal-notify.test.ts assert title strings; this file
 * fakes a TTY and captures the exact bytes the title port writes, asserting
 * the animation cycles frames over time and stops cleanly. On Windows this is
 * the only practical way to observe the bytes, because a piped stdout is not a
 * TTY and the production gate would (correctly) suppress the write.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildTerminalTitle,
  setTerminalTitle,
  setTitleWriterForTests,
  startTitleAnimation,
  stopTitleAnimation,
} from "./terminal-notify.js"

/** Raw chunks written to fd 1, in order. */
const captured: string[] = []
let realIsTTY: boolean | undefined

/** OSC 0 payload text from each captured chunk (BEL-terminated). */
function observedTitles(): string[] {
  return captured.map((chunk) => /\x1b\]0;([^\x07\x1b]*)\x07/.exec(chunk)?.[1] ?? "")
}

beforeEach(() => {
  captured.length = 0
  realIsTTY = process.stdout.isTTY
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
  setTitleWriterForTests((_fd, text) => captured.push(text))
})

afterEach(() => {
  stopTitleAnimation()
  setTitleWriterForTests(null)
  Object.defineProperty(process.stdout, "isTTY", { value: realIsTTY, configurable: true })
  vi.useRealTimers()
})

describe("terminal title bytes on a TTY", () => {
  it("writes a BEL-terminated OSC 0 sequence carrying the product name", () => {
    setTerminalTitle(buildTerminalTitle({ activity: "idle" }))
    expect(captured).toEqual(["\x1b]0;Nemo\x07"])
    expect(observedTitles()).toEqual(["Nemo"])
  })

  it("animates across distinct frames, then settles on the static title", () => {
    vi.useFakeTimers()
    startTitleAnimation({ backgroundCount: 1 })
    vi.advanceTimersByTime(120 * 6)
    stopTitleAnimation(buildTerminalTitle({ activity: "idle" }))

    const titles = observedTitles()
    // Initial frame + ticks, then the final static title.
    expect(titles.length).toBeGreaterThanOrEqual(6)
    // Really animating: several distinct titles while spinning.
    expect(new Set(titles.slice(0, -1)).size).toBeGreaterThan(1)
    for (const title of titles) expect(title).toContain("Nemo")
    expect(titles[titles.length - 1]).toBe("Nemo")

    // Nothing more arrives after stop() — no leaked interval.
    const afterStop = captured.length
    vi.advanceTimersByTime(120 * 10)
    expect(captured.length).toBe(afterStop)
  })

  it("cycles the four ASCII frames in order", () => {
    vi.useFakeTimers()
    startTitleAnimation()
    vi.advanceTimersByTime(120 * 4)
    stopTitleAnimation()
    const frames = observedTitles().map((title) => title[0])
    expect(frames).toEqual(["|", "/", "-", "\\", "|"])
  })

  it("dedupes: setting the same title repeatedly writes once", () => {
    setTerminalTitle("Nemo - working")
    setTerminalTitle("Nemo - working")
    setTerminalTitle("Nemo - working")
    expect(captured).toHaveLength(1)
  })

  it("writes nothing when the kill-switch is set", () => {
    vi.useFakeTimers()
    process.env.NEMO_NO_NOTIFY = "1"
    try {
      setTerminalTitle("Nemo")
      startTitleAnimation()
      vi.advanceTimersByTime(500)
      stopTitleAnimation()
      expect(captured).toHaveLength(0)
    } finally {
      delete process.env.NEMO_NO_NOTIFY
    }
  })

  it("writes nothing when stdout is not a TTY (pipes stay clean)", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true })
    setTerminalTitle("Nemo")
    startTitleAnimation()
    stopTitleAnimation()
    expect(captured).toHaveLength(0)
  })
})
