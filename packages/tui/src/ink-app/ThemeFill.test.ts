/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

const OLD_FORCE_COLOR = process.env.FORCE_COLOR
process.env.FORCE_COLOR = "3"

import { afterAll, describe, expect, it } from "vitest"
import React from "react"
import { PassThrough } from "node:stream"

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

afterAll(() => {
  if (OLD_FORCE_COLOR === undefined) delete process.env.FORCE_COLOR
  else process.env.FORCE_COLOR = OLD_FORCE_COLOR
})

function bgRuns(raw: string): string[] {
  return [...raw.matchAll(/\x1b\[48;2;(\d+);(\d+);(\d+)m/g)].map((m) =>
    [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join(""),
  )
}

async function renderFill(rows: number, background: string, width: number): Promise<string> {
  // ink is imported dynamically: a static import hoists above FORCE_COLOR.
  const { render } = await import("ink")
  const { ThemeFill } = await import("./ThemeFill.js")
  const pass = new PassThrough()
  let sink = ""
  pass.on("data", (c) => (sink += c.toString()))
  const stdout = Object.assign(pass, { isTTY: true, columns: width, rows: rows + 4 }) as unknown as NodeJS.WriteStream
  const instance = render(React.createElement(ThemeFill, { rows, background, width }), {
    stdout,
    patchConsole: false,
  })
  await wait(200)
  instance.unmount()
  await wait(30)
  return sink
}

describe("ThemeFill", () => {
  it("paints every empty row with the theme background", async () => {
    // The whole point: without real rows on those lines, Ink writes nothing
    // and the terminal's own black backdrop shows through.
    const raw = await renderFill(6, "#011627", 40)
    const runs = bgRuns(raw)
    expect(runs.filter((r) => r === "011627").length).toBeGreaterThanOrEqual(6)
  }, 15000)

  it("follows the theme colour instead of a fixed black", async () => {
    const raw = await renderFill(3, "#1a1b26", 40)
    expect(bgRuns(raw)).toContain("1a1b26")
    expect(bgRuns(raw)).not.toContain("000000")
  }, 15000)

  it("renders no painted row for zero rows (no wasted repaint on a short screen)", async () => {
    const raw = await renderFill(0, "#011627", 40)
    expect(bgRuns(raw)).toHaveLength(0)
  }, 15000)

  it("clamps a silly row count", async () => {
    const raw = await renderFill(5000, "#011627", 20)
    // Each fill row emits exactly one background run; the clamp caps it at
    // 200 so a huge/garbage terminal size can't flood the renderer.
    expect(bgRuns(raw).length).toBeLessThanOrEqual(200)
    expect(bgRuns(raw).length).toBeGreaterThan(0)
  }, 15000)
})