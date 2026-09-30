/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { resetGlyphCache } from "./glyphs.js"
import React from "react"
import { PassThrough } from "node:stream"
import { render, Box, type Instance } from "ink"
import { ThemePicker, type ThemeOption } from "./ThemePicker.js"

/**
 * First-run theme picker: NO row overlays (reported live on a short
 * terminal).
 *
 * The picker paints inside App's FIXED-height bordered root. Ink's Box
 * defaults to flexShrink:1, so when the children didn't fit they were
 * SQUEEZED while their Text still painted at natural height — rows stacked
 * ON TOP of rows: "Pick the text style…" landed inside the logo art (the
 * title vanished), "▼ 41 more" overwrote the tail of "  Orange Light
 * light" (leaving "ght  light"), and the accent line overwrote the
 * preview's bottom border. fitLayout() now budgets every child to
 * rows-4 and flexShrink={0} forbids the squeeze.
 *
 * The render mirrors production: App's fixed-height bordered root box.
 */

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")

/** Poll the frame sink until `needle` shows up (frames arrive async). */
async function waitFor(sink: () => string, needle: string, ms = 4000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (sink().includes(needle)) return true
    await wait(25)
  }
  return false
}

const openStdio = (
  columns: number,
  rows: number,
): { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream; sink: () => string } => {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => {},
    ref: () => {},
    unref: () => {},
  }) as unknown as NodeJS.ReadStream
  const rawOut = new PassThrough()
  let captured = ""
  rawOut.on("data", (chunk: Buffer) => {
    captured += chunk.toString()
  })
  const stdout = Object.assign(rawOut, {
    isTTY: true,
    columns,
    rows,
  }) as unknown as NodeJS.WriteStream
  return { stdin, stdout, sink: () => captured }
}

/** 53 themes (17 bundled + 36 ported) like production. */
const themes: ThemeOption[] = Array.from({ length: 53 }, (_, i) => ({
  name: `t${i}`,
  label: `Theme ${i}`,
  swatch: "#6cb6f5",
}))

const TITLE = "Trayambak — Choose a Theme"

// Glyphs under test render through glyphs.ts, which auto-selects ASCII on
// plain Windows consoles (this CI/dev box) — assertions below pin Unicode
// shapes, so force unicode mode here. resetGlyphCache covers shared workers.
process.env.TRAYAMBAK_GLYPHS = "unicode"
resetGlyphCache()
describe("ThemePicker fits its fixed-height frame (no row overlays)", () => {
  it("short terminal (rows=27): header below the full logo, exact ▼ row, no preview", async () => {
    const { stdin, stdout, sink } = openStdio(124, 27)
    let instance: Instance | undefined
    try {
      instance = render(
        React.createElement(
          Box,
          { height: 27, borderStyle: "single" },
          React.createElement(ThemePicker, { themes, onSelect: () => {}, onExit: () => {} }),
        ),
        { stdin, stdout, patchConsole: false },
      )
      expect(await waitFor(sink, "Pick the text style")).toBe(true)
      await wait(150)

      const out = stripAnsi(sink())
      // Frame borders (│) wrap every row; strip them so rows compare exactly
      // (ghost tails from an overlay would survive the trim and fail).
      const lines = out.split("\n").map((l) => l.replace(/│/g, "").trim())

      // 1. The logo painted its art (this screen must keep its logo).
      const lastArt = Math.max(out.lastIndexOf("▀"), out.lastIndexOf("▄"))
      expect(lastArt).toBeGreaterThanOrEqual(0)

      // 2. The header sits BELOW every art row, title first (pre-fix the
      //    subtitle rendered INSIDE the logo and the title never appeared).
      expect(lines).toContain(TITLE)
      const title = out.lastIndexOf(TITLE)
      const subtitle = out.lastIndexOf("Pick the text style")
      expect(title).toBeGreaterThan(lastArt)
      expect(subtitle).toBeGreaterThan(title)

      // 3. The ▼ row is EXACT — pre-fix the shorter "▼ N more" painted over
      //    an item row leaving its ghost tail ("▼ 41 moreght  light").
      //    rows=27 → avail 23, full logo, preview yields to the list:
      //    5 visible of 53 → 48 more.
      expect(lines).toContain("▼ 48 more")

      // 4. The budget dropped the preview box here rather than overlap.
      expect(out).not.toContain("Accent colour")
    } finally {
      instance?.unmount()
    }
  }, 15000)

  it("taller terminal (rows=40): preview renders inside its border, not over it", async () => {
    const { stdin, stdout, sink } = openStdio(124, 40)
    let instance: Instance | undefined
    try {
      instance = render(
        React.createElement(
          Box,
          { height: 40, borderStyle: "single" },
          React.createElement(ThemePicker, { themes, onSelect: () => {}, onExit: () => {} }),
        ),
        { stdin, stdout, patchConsole: false },
      )
      expect(await waitFor(sink, "Pick the text style")).toBe(true)
      await wait(150)

      const out = stripAnsi(sink())
      const lines = out.split("\n").map((l) => l.replace(/│/g, "").trim())

      // 1. Header below the logo art, title present and first.
      const lastArt = Math.max(out.lastIndexOf("▀"), out.lastIndexOf("▄"))
      expect(lastArt).toBeGreaterThanOrEqual(0)
      expect(lines).toContain(TITLE)
      expect(out.lastIndexOf(TITLE)).toBeGreaterThan(lastArt)
      expect(out.lastIndexOf("Pick the text style")).toBeGreaterThan(out.lastIndexOf(TITLE))

      // 2. Preview box: top border on its own row…
      expect(lines.some((l) => /^╭─+╮$/.test(l))).toBe(true)
      // …and the accent line on ITS OWN row — pre-fix it shared the bottom
      // border row: "╰  Accent colour: #6cb6f5─────╯".
      expect(lines).toContain("Accent colour: #6cb6f5")
      expect(lines.some((l) => l.includes("Accent colour") && /[╰─╮╭╯]/.test(l))).toBe(false)

      // 3. Exact ▼ row: rows=40 → avail 36, full logo + preview → 8 of 53.
      expect(lines).toContain("▼ 45 more")
    } finally {
      instance?.unmount()
    }
  }, 15000)
})
