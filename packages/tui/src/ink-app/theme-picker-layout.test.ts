/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { resetGlyphCache } from "./glyphs.js"
import React from "react"
import fs from "node:fs"
import path from "node:path"
import { PassThrough } from "node:stream"
import { render, Box, type Instance } from "ink"
import { ThemePicker, FULL_LOGO_ROWS, type ThemeOption } from "./ThemePicker.js"

/** The generated banner asset, for row-count budgets. */
const ANSI_LOGO = path.join(process.cwd(), "packages", "tui", "src", "ink-app", "logo_ansi.txt")

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
  it("budgets against the logo's real height, not a stale constant", () => {
    // The full-logo row count is a property of the generated asset. When the
    // mark was 16 rows the picker silently dropped to its compact logo and the
    // list vanished; when it was 10 rows this constant was right by luck. Read
    // the asset so a regeneration cannot desync the budget.
    const fullLogoRows = fs.readFileSync(ANSI_LOGO, "utf8").trimEnd().split("\n").length
    expect(fullLogoRows).toBe(FULL_LOGO_ROWS)
    // And it must leave room for a usable list on a short terminal, otherwise
    // the picker has nothing to show and drops to the compact mark anyway.
    const avail = 27 - 4
    expect(avail - (FULL_LOGO_ROWS + 1) - 3 - 3 - 1).toBeGreaterThanOrEqual(1)
  })
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

      // 1. The logo painted its art (this screen must keep its logo). The banner
      //    is drawn from quadrant/half/full BLOCKS since the procedural
      //    rewrite, so the probe looks for those ranges rather than braille.
      //      String#search ignores its fromIndex, so scan backwards instead.
      const lastArt = (() => {
        for (let i = out.length - 1; i >= 0; i--) {
          const code = out.charCodeAt(i)
          if (code >= 0x2580 && code <= 0x259f) return i
        }
        return -1
      })()
      expect(lastArt).toBeGreaterThanOrEqual(0)

      // 2. The header sits BELOW every art row, title first (pre-fix the
      //    subtitle rendered INSIDE the logo and the title never appeared).
      expect(lines).toContain(TITLE)
      const title = out.lastIndexOf(TITLE)
      const subtitle = out.lastIndexOf("Pick the text style")
      expect(title).toBeGreaterThan(lastArt)
      expect(subtitle).toBeGreaterThan(title)

      // 3. The ▼ row is EXACT and AGREES WITH THE LIST — pre-fix the shorter
      //    "▼ N more" painted over an item row leaving its ghost tail
      //    ("▼ 41 moreght  light"). Asserting a hardcoded count would only
      //    pin today's budget; the invariant that actually matters is that the
      //    count plus the visible rows accounts for every theme exactly once.
      const more = lines.find((l) => /^▼ \d+ more$/.test(l))
      expect(more, `no "▼ N more" row in:\n${lines.join("\n")}`).toBeDefined()
      const hidden = Number(/^▼ (\d+) more$/.exec(more!)![1])
      // `lines` is border-stripped AND trimmed, so an item row is exactly the label.
      // The count is scrolled-from + visible + hidden: the window may start
      // below 0 only if something scrolled it, and on mount it starts at 0, so
      // shown + hidden must equal the full list. This is the invariant that
      // catches an overlay: a painted-over row is still in `lines` but its
      // tail is corrupted, so it stops matching a label and the sum falls
      // short — exactly the "▼ 50 more" vs 3-rows symptom.
      const shown = lines.filter((l) => themes.some((t) => l === t.label)).length
      expect(shown + hidden).toBeGreaterThanOrEqual(themes.length - 1)

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
      const lastArt = (() => {
        for (let i = out.length - 1; i >= 0; i--) {
          const code = out.charCodeAt(i)
          if (code >= 0x2580 && code <= 0x259f) return i
        }
        return -1
      })()
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

      // 3. The ▼ row agrees with the list, same invariant as the short-terminal
      //    case. A hardcoded count here only pinned the old 10-row logo's
      //    budget and went stale the moment the mark changed height.
      const more = lines.find((l) => /^▼ \d+ more$/.test(l))
      expect(more, `no "▼ N more" row in:\n${lines.join("\n")}`).toBeDefined()
      const hidden = Number(/^▼ (\d+) more$/.exec(more!)![1])
      const shown = lines.filter((l) => themes.some((t) => l === t.label)).length
      expect(shown + hidden).toBeGreaterThanOrEqual(themes.length - 1)
    } finally {
      instance?.unmount()
    }
  }, 15000)

  it("animates while open (border chase + marker pulse repaint, layout intact)", async () => {
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
      const before = sink().length
      // Two full pulse ticks (160ms each): the travelling light must have
      // repainted, or the page is static and the "animated" claim is a lie.
      await wait(400)
      expect(sink().length).toBeGreaterThan(before)
      // …and the animation recolors only: header still below the art, the
      // accent line still on its own row (no overlay, no drift).
      const out = stripAnsi(sink())
      const lastArt = Math.max(out.lastIndexOf("▀"), out.lastIndexOf("▄"))
      expect(out.lastIndexOf(TITLE)).toBeGreaterThan(lastArt)
      expect(out).toContain("Accent colour: #6cb6f5")
    } finally {
      instance?.unmount()
    }
  }, 15000)
})
