/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Rounded footer section ("ye section bhi rounded" / "upar bhi ek line"):
 * the model row sits in a COMPLETE rounded panel — ╭──╮ on top, │ walls,
 * azure ╰──╯ below (the bottom replaced the old plain ─── rule). Pinned
 * behaviors: exactly one top and one bottom border row, their ─ run
 * widths, hardcoded blue (theme-independent), never wraps or overflows
 * into a second line.
 *
 * Solo render (this test mounts Footer alone, no App root around it): the
 * box spans all `columns`, so each run is columns-2 — in-app the root
 * frame border eats 2 more → columns-4, the exact length the old rule
 * carried (FRAME_OVERHEAD in footer-fit.ts).
 *
 * FORCE_COLOR=3 before ink loads (same pattern as tool-call-pulse):
 * vitest stdout is a pipe, chalk level would be 0 and the blue SGR would
 * never be emitted, making the colour assertion vacuous.
 */
const OLD_FORCE_COLOR = process.env.FORCE_COLOR
process.env.FORCE_COLOR = "3"

import { afterAll, describe, expect, it } from "vitest"
import React from "react"
import { PassThrough } from "node:stream"
import type { Instance } from "ink"
import type { StatusBarInfo } from "./types.js"

const { render } = await import("ink")
const { Footer } = await import("./Footer.js")

afterAll(() => {
  if (OLD_FORCE_COLOR === undefined) delete process.env.FORCE_COLOR
  else process.env.FORCE_COLOR = OLD_FORCE_COLOR
})

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

async function footerLines(columns: number): Promise<{ lines: string[]; raw: string }> {
  const pass = new PassThrough()
  let sink = ""
  pass.on("data", (c) => (sink += c.toString()))
  const stdout = Object.assign(pass, { isTTY: true, columns, rows: 40 }) as unknown as NodeJS.WriteStream
  const info: StatusBarInfo = {
    model: "nvidia/nemotron-3-super-120b-a12b",
    permissionMode: "ask",
    status: "idle",
    tokenCount: 80,
  }
  let instance: Instance | undefined
  try {
    instance = render(React.createElement(Footer, { info }), { stdout, patchConsole: false })
    await wait(150)
  } finally {
    instance?.unmount()
  }
  await wait(30)
  return {
    lines: sink
      .split(/\r?\n/)
      .map(stripAnsi)
      .filter((l) => l.trim().length > 0),
    raw: sink,
  }
}

describe("Footer rounded section border", () => {
  for (const columns of [100, 60]) {
    it(`renders a COMPLETE box: one top + one bottom border at ${columns} cols`, async () => {
      const { lines } = await footerLines(columns)
      // "upar bhi ek line add model ke box ko complete krne ke liye": the
      // panel must close on BOTH sides — ╭──╮ above the model row and
      // ╰──╯ below it (which replaced the old plain ─── rule).
      const tops = lines.map((l) => l.trim()).filter((l) => /^╭─+╮$/.test(l))
      const bottoms = lines.map((l) => l.trim()).filter((l) => /^╰─+╯$/.test(l))
      expect(tops.length).toBe(1)
      expect(bottoms.length).toBe(1)
      // Solo render has no root frame around the Footer: the box spans all
      // `columns`, so each run is columns-2 (in-app the root border eats
      // 2 more → columns-4).
      expect((tops[0] as string).match(/^╭(─+)╮$/)?.[1]?.length).toBe(columns - 2)
      expect((bottoms[0] as string).match(/^╰(─+)╯$/)?.[1]?.length).toBe(columns - 2)
    }, 15000)

    it(`border is hardcoded blue at ${columns} cols (theme-independent)`, async () => {
      const { raw } = await footerLines(columns)
      // #2EA6FF → 24-bit SGR 38;2;46;166;255 immediately before the run.
      expect(raw).toContain("38;2;46;166;255")
    }, 15000)
  }
})
