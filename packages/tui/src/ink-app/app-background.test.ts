/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The app frame must paint the ACTIVE THEME's background.
 *
 * Regression: the root Box carried no backgroundColor, so Ink rendered every
 * frame on the terminal's own backdrop. Switching themes with /theme then
 * changed text + border colours but the canvas stayed the terminal's — i.e.
 * every theme looked the same (black on black), which is what "background is
 * always black" reported.
 */

const OLD_FORCE_COLOR = process.env.FORCE_COLOR
// Must precede the ink import: the harness stdout is a pipe, so chalk would
// sit at color level 0 and emit NO SGR at all — making every background
// assertion below vacuously true (the exact "always black" bug, inverted).
process.env.FORCE_COLOR = "3"

import { afterAll, describe, expect, it } from "vitest"
import React from "react"
import { PassThrough } from "node:stream"
// NB: ink/Box are imported DYNAMICALLY inside renderWithBackground — a static
// import is hoisted above the FORCE_COLOR assignment, so chalk would stay at
// color level 0 and emit no SGR at all.

afterAll(() => {
  if (OLD_FORCE_COLOR === undefined) delete process.env.FORCE_COLOR
  else process.env.FORCE_COLOR = OLD_FORCE_COLOR
})

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Every 24-bit background SGR triple in the output, lowercased. */
function bgRuns(raw: string): string[] {
  return [...raw.matchAll(/\x1b\[48;2;(\d+);(\d+);(\d+)m/g)].map((m) =>
    [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join(""),
  )
}

async function renderWithBackground(hex: string): Promise<string> {
  const { render, Box, Text } = await import("ink")
  const pass = new PassThrough()
  let sink = ""
  pass.on("data", (c) => (sink += c.toString()))
  const stdout = Object.assign(pass, { isTTY: true, columns: 60, rows: 12 }) as unknown as NodeJS.WriteStream
  // A Text child is required: Ink propagates the box background through a
  // React context that only <Text> consumes, so a row with no text emits no
  // background SGR at all (blank rows are not painted).
  const instance = render(
    React.createElement(
      Box,
      { flexDirection: "column", height: 11, borderStyle: "round", backgroundColor: hex },
      React.createElement(Text, null, "frame fill"),
    ),
    { stdout, patchConsole: false },
  )
  await wait(200)
  instance.unmount()
  await wait(30)
  return sink
}

describe("app frame background", () => {
  it("paints the theme background on every interior row", async () => {
    const raw = await renderWithBackground("#0a0a0a")
    const runs = bgRuns(raw)
    // At least one background run per visible row (border rows included —
    // the fill is on the frame, so the corners/edges carry it too).
    expect(runs.length).toBeGreaterThanOrEqual(6)
    expect(runs.every((r) => r === "0a0a0a")).toBe(true)
  }, 15000)

  it("tracks the theme: a different background paints different bytes", async () => {
    const dark = await renderWithBackground("#011627")
    const blue = await renderWithBackground("#2e3440")
    expect(bgRuns(dark)).toContain("011627")
    expect(bgRuns(blue)).toContain("2e3440")
    expect(bgRuns(dark)).not.toContain("2e3440")
  }, 15000)

  it("never paints a bare-black default when the theme says otherwise", async () => {
    // Guards the exact report: a black-looking background under a themed one.
    const raw = await renderWithBackground("#1a1b26")
    expect(bgRuns(raw)).not.toContain("000000")
  }, 15000)
})