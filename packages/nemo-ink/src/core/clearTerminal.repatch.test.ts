/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * A repaint must never delete the transcript (#125).
 *
 * The chat UI keeps its history by PRINTING settled rows to the terminal's
 * native scrollback through Ink's `<Static>`, then repainting only the live tail
 * in-frame. That makes the scrollback the app's permanent record and the reason
 * the device's own scrollbar is an accurate view of the conversation.
 *
 * The renderer's flicker recovery broke that. On a window resize — or any
 * offscreen reflow — `log-update.ts` falls back to `fullResetSequence`, which
 * emits a `clearTerminal` patch, and that patch was rendered with
 * `ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME`. ED3 wipes the scrollback, so
 * every already-printed message was deleted from the terminal: the transcript
 * disappeared on resize and scrolling back showed nothing.
 *
 * A repaint is not a reset. The recovery path must clear the SCREEN and keep
 * the scrollback, which is the only place the printed history lives.
 */
import { describe, expect, it } from "vitest"
import { getClearScreenSequence, getClearTerminalSequence } from "./clearTerminal.js"

describe("getClearScreenSequence", () => {
  it("erases the screen", () => {
    expect(getClearScreenSequence()).toContain("\x1b[2J")
  })

  it("homes the cursor so the next frame starts at the top", () => {
    expect(getClearScreenSequence()).toContain("\x1b[H")
  })

  it("NEVER erases the scrollback — that is where the printed history lives", () => {
    // ED3 here is the bug this module exists to prevent: it silently deleted
    // every message the UI had already printed.
    expect(getClearScreenSequence()).not.toContain("\x1b[3J")
  })

  it("is terminal-independent, because keeping history is always correct", () => {
    // Unlike the full sequence there is no capability branch here: dropping the
    // scrollback is never the right answer for a repaint, on any terminal.
    expect(getClearScreenSequence()).toBe("\x1b[2J\x1b[H")
  })
})

describe("getClearTerminalSequence", () => {
  it("always erases the screen, whatever the terminal", () => {
    expect(getClearTerminalSequence()).toContain("\x1b[2J")
  })

  it("is capability-aware: ED3 only where the terminal supports it", () => {
    // Deliberately NOT asserted as always-present. On a modern Windows Terminal
    // this includes ED3 (scrollback goes); on legacy conhost it cannot, and on
    // a non-Windows host it does. What matters is that the flicker path never
    // reaches this function — that is asserted through the write path below.
    const seq = getClearTerminalSequence()
    expect(seq.startsWith("\x1b[2J")).toBe(true)
    // Whatever branch it takes, it must end by putting the cursor home.
    expect(seq.endsWith("\x1b[H") || seq.endsWith("\x1b[0f")).toBe(true)
  })
})

describe("repatch: the renderer uses the screen-only sequence", () => {
  it("renders the clearTerminal patch without ED3", async () => {
    // End-to-end through the real write path, not a source-grep: the bug lived
    // in which sequence the patch handler picked, so that is what is asserted.
    const { Writable } = await import("stream")
    const { writeDiffToTerminal } = await import("./terminal.js")
    let written = ""
    const sink = new Writable({
      write(chunk: Buffer | string, _enc: unknown, done: () => void) {
        written += String(chunk)
        done()
      },
    })
    writeDiffToTerminal({ stdout: sink, stderr: sink }, [{ type: "clearTerminal" }] as never)
    expect(written).toContain("\x1b[2J")
    expect(written).not.toContain("\x1b[3J")
  })
})
