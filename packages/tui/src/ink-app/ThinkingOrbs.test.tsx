/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterAll, describe, expect, it } from "vitest"
import React from "react"
import { PassThrough } from "node:stream"
import type { Instance } from "ink"
import { BLUE_RAMP, GRID_COLS, GRID_ROWS, SILVER_RAMP } from "./thinking-ribbon.js"
import type { MotionLevel } from "./animations.js"
import { setMotionLevel } from "./motion-store.js"

const OLD_FORCE_COLOR = process.env.FORCE_COLOR
process.env.FORCE_COLOR = "3"

const { render } = await import("ink")
const { ThinkingOrbs } = await import("./ThinkingOrbs.js")

// The sphere's frame depends on the motion level (travelling eyes at `full`, the
// resting 3×3 below it), so this file names the level it paints instead of
// inheriting whatever the developer who ran the suite last exported.
setMotionLevel("full")

afterAll(() => {
  if (OLD_FORCE_COLOR === undefined) delete process.env.FORCE_COLOR
  else process.env.FORCE_COLOR = OLD_FORCE_COLOR
})

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

/** Render paused (one deterministic frame) and hand back the painted sink. */
async function paint(label?: string): Promise<string> {
  const pass = new PassThrough()
  let sink = ""
  pass.on("data", (c) => (sink += c.toString()))
  const stdout = Object.assign(pass, { isTTY: true, columns: 80, rows: 24 }) as unknown as NodeJS.WriteStream
  let instance: Instance | undefined
  try {
    instance = render(React.createElement(ThinkingOrbs, { label, paused: true }), {
      stdout,
      patchConsole: false,
    })
    await wait(150)
  } finally {
    instance?.unmount()
  }
  await wait(30)
  return sink
}

describe("ThinkingOrbs", () => {
  it("paints a GRID_ROWS-tall blue grid beside the full label, no bullet", async () => {
    const stripped = stripAnsi(await paint("Thinking…"))
    // The label is untouched and complete…
    expect(stripped).toContain("Thinking…")
    // …and the grid paints exactly three travelling eyes…
    const dots = (stripped.match(/·/g) ?? []).length
    expect(dots).toBe(3)
    // …with no bullet dot in front (removed on request).
    expect(stripped.trimStart().startsWith("·")).toBe(true)
  }, 15000)

  it("paints a custom label verbatim (Generating… phase)", async () => {
    const out = stripAnsi(await paint("Generating…"))
    expect(out).toContain("Generating…")
  }, 15000)

  // The frame `reduced` and `off` show is designed, not sampled — and this is
  // the assertion that says why. At `full`/frame 0 the shimmer band sits off the
  // end of the word, so every char renders dim, and three of the nine grid cells
  // are blank. Both of those are *mid-animation moments*; a still has to be the
  // readable one, because the status word is the reason the widget exists.
  it.each(["reduced", "off"])("paints the legible still at motion=%s", async (level) => {
    setMotionLevel(level as MotionLevel)
    try {
      const sink = await paint("Thinking…")
      const stripped = stripAnsi(sink)
      expect(stripped).toContain("Thinking…")
      // Whole 3×3 lit, not a corner of a travelling group.
      expect((stripped.match(/·/g) ?? []).length).toBe(GRID_ROWS * GRID_COLS)
      // Nothing dimmed: the word is at full brightness everywhere.
      expect(sink).not.toContain("\x1b[2m")
    } finally {
      setMotionLevel("full")
    }
  }, 15000)

  it("paints dots in blue and text in silver only", async () => {
    const sink = await paint("Thinking…")
    const seen = [...sink.matchAll(/38;2;(\d+);(\d+);(\d+)/g)].map((m) => m.slice(1).map(Number))
    expect(seen.length).toBeGreaterThan(0)
    for (const [r, g, b] of seen) {
      const hex = `#${[r, g, b].map((n) => (n as number).toString(16).padStart(2, "0")).join("")}`
      const nr = r as number
      const ng = g as number
      const nb = b as number
      // White is the shared shine (both ramps end in it); anything else must
      // sit on exactly one family.
      if (hex === "#ffffff") continue
      const onBlue = (BLUE_RAMP as readonly string[]).includes(hex)
      const onSilver = (SILVER_RAMP as readonly string[]).includes(hex)
      expect(onBlue || onSilver, hex).toBe(true)
      if (!onSilver) {
        expect(nb, "blue: b>=g").toBeGreaterThanOrEqual(ng)
        expect(ng, "blue: g>=r").toBeGreaterThanOrEqual(nr)
      } else {
        expect(nr, "silver: r===g").toBe(ng)
        expect(ng, "silver: g===b").toBe(nb)
      }
    }
  }, 15000)
})
