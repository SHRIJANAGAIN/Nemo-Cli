/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * The startup banner.
 *
 * Two assets ship for the same mark: `logo_ansi.txt` (its palette baked in as
 * SGR) and `trayambak-logo.txt` (plain text, 7 lines). Only the first one
 * used to render in colour — the monochrome fallback came out flat
 * default-foreground and ignored the active /theme entirely. It now gets a
 * per-line fade from accent into body text.
 *
 * FORCE_COLOR=3 before ink loads (same pattern as footer-rule): vitest stdout
 * is a pipe, so chalk would sit at level 0 and never emit SGR, making every
 * colour assertion below vacuous.
 */
const OLD_FORCE_COLOR = process.env.FORCE_COLOR
const OLD_LOGO_PATH = process.env.TRAYAMBAK_LOGO_PATH
process.env.FORCE_COLOR = "3"

import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import { PassThrough } from "node:stream"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import React from "react"
import type { Instance } from "ink"

const INK_APP = path.join(process.cwd(), "packages", "tui", "src", "ink-app")
const MONO_LOGO = path.join(INK_APP, "trayambak-logo.txt")
const ANSI_LOGO = path.join(INK_APP, "logo_ansi.txt")

/** CRLF twin of the real art, proving a checkout poisoned by core.autocrlf
 *  renders cleanly. Unlinked in afterAll. */
const CRLF_LOGO = path.join(os.tmpdir(), "trayambak-logo-crlf.txt")

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

afterAll(() => {
  if (OLD_FORCE_COLOR === undefined) delete process.env.FORCE_COLOR
  else process.env.FORCE_COLOR = OLD_FORCE_COLOR
  if (fs.existsSync(CRLF_LOGO)) fs.unlinkSync(CRLF_LOGO)
})

beforeAll(() => {
  // Reproduce core.autocrlf=true checkout: same bytes as the shipped art,
  // only line endings differ.
  const art = fs.readFileSync(ANSI_LOGO, "utf8")
  fs.writeFileSync(CRLF_LOGO, art.replace(/\r?\n/g, "\r\n"), "utf8")
})

afterEach(() => {
  if (OLD_LOGO_PATH === undefined) delete process.env.TRAYAMBAK_LOGO_PATH
  else process.env.TRAYAMBAK_LOGO_PATH = OLD_LOGO_PATH
  vi.resetModules()
})

/**
 * Mount the logo against a specific asset and return the raw output.
 *
 * The module memoises the banner in `logoCache`, so the registry is reset per
 * case — otherwise the first asset would win for the whole file and the
 * second assertion would silently test the first asset again.
 */
async function renderLogo(logoPath: string, compact = false): Promise<string> {
  vi.resetModules()
  process.env.TRAYAMBAK_LOGO_PATH = logoPath
  const { render } = await import("ink")
  const { TrayambakLogo } = await import("./TrayambakLogo.js")

  const pass = new PassThrough()
  let sink = ""
  pass.on("data", (c) => (sink += c.toString()))
  const stdout = Object.assign(pass, { isTTY: true, columns: 120, rows: 40 }) as unknown as NodeJS.WriteStream

  let instance: Instance | undefined
  try {
    instance = render(React.createElement(TrayambakLogo, { compact }), { stdout, patchConsole: false })
    await wait(150)
  } finally {
    instance?.unmount()
  }
  await wait(30)
  return sink
}

/** Every 24-bit foreground SGR triple in the output, in emission order. */
function fgRuns(raw: string): string[] {
  return [...raw.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map((m) => `${m[1]},${m[2]},${m[3]}`)
}

/**
 * Render the banner inside a round-bordered Box, which is how the app does it
 * (App.tsx > WelcomeScreen > TrayambakLogo).
 *
 * The border is NOT optional for reproducing the CR bug: Ink strips a bare
 * <Text> CR before writing (bare render → totalCR 0), but inside a bordered
 * Box the CR survives to the wire and rewinds the cursor mid-row. A test that
 * renders the logo bare passes with or without the fix, which is exactly how
 * the first version of this test stayed green while broken.
 */
async function renderLogoBordered(logoPath: string): Promise<string> {
  vi.resetModules()
  process.env.TRAYAMBAK_LOGO_PATH = logoPath
  const { Box, render } = await import("ink")
  const { TrayambakLogo } = await import("./TrayambakLogo.js")

  const pass = new PassThrough()
  let sink = ""
  pass.on("data", (c) => (sink += c.toString()))
  const stdout = Object.assign(pass, { isTTY: true, columns: 120, rows: 40 }) as unknown as NodeJS.WriteStream

  let instance: Instance | undefined
  try {
    instance = render(
      React.createElement(
        Box,
        { flexDirection: "column", borderStyle: "round", height: 29 },
        React.createElement(TrayambakLogo, { compact: false }),
      ),
      { stdout, patchConsole: false },
    )
    await wait(150)
  } finally {
    instance?.unmount()
  }
  await wait(30)
  return sink
}

/** \r with printable content after it (the normal \r\n line pairing excluded). */
function midLineCarriageReturns(raw: string): number {
  return [...raw].filter((ch, i) => ch === "\r" && raw[i + 1] !== "\n").length
}

describe("TrayambakLogo monochrome fallback", () => {
  it("emits one gradient colour per banner line", async () => {
    const raw = await renderLogo(MONO_LOGO)
    const runs = fgRuns(raw)

    // 7 lines in trayambak-logo.txt, and each must be painted — an unpainted
    // line is exactly the monochrome bug this path had.
    expect(runs.length).toBeGreaterThanOrEqual(7)
    expect(new Set(runs).size).toBeGreaterThan(1)
  }, 15000)

  it("fades downward: a later line is not painted the same as the first", async () => {
    const raw = await renderLogo(MONO_LOGO)
    const runs = fgRuns(raw)

    expect(runs[0]).not.toBe(runs[runs.length - 1])
  }, 15000)

  it("renders the plain asset with no leftover SGR doubling the paint", async () => {
    const raw = await renderLogo(MONO_LOGO)
    // The monochrome file has no ANSI of its own, so every SGR in the output
    // is ours. A doubled style would show up as a run immediately followed by
    // another run with no printable character between them.
    expect(/\x1b\[38;2;\d+;\d+;\d+m\x1b\[38;2;\d+;\d+;\d+m[^\x1b]*\S/.test(raw)).toBe(false)
  }, 15000)
})

describe("TrayambakLogo ANSI asset", () => {
  it("renders the art's own baked palette rather than overriding it", async () => {
    const raw = await renderLogo(ANSI_LOGO)

    expect(fgRuns(raw).length).toBeGreaterThan(0)
    // Same guard as above: the art carries its own colours, so we must not
    // stack a gradient on top of them.
    expect(/\x1b\[38;2;\d+;\d+;\d+m\x1b\[38;2;\d+;\d+;\d+m[^\x1b]*\S/.test(raw)).toBe(false)
  }, 15000)
})

describe("TrayambakLogo compact", () => {
  it("paints the wordmark from the active theme, not a hardcoded green", async () => {
    const raw = await renderLogo(MONO_LOGO, /*compact*/ true)

    expect(raw).toContain("TRAYAMBAK")
    expect(fgRuns(raw).length).toBeGreaterThan(0)
    // #00ff00 was the old literal.
    expect(raw).not.toContain("0,255,0")
  }, 15000)
})

describe("hexToSgr", () => {
  it("converts #rrggbb (with or without #) to an SGR triplet", async () => {
    const { hexToSgr } = await import("./TrayambakLogo.js")
    expect(hexToSgr("#0a0a0a")).toBe("10;10;10")
    expect(hexToSgr("011627")).toBe("1;22;39")
    expect(hexToSgr("#FFFFFF")).toBe("255;255;255")
  })

  it("refuses unusable input instead of emitting a broken escape", async () => {
    const { hexToSgr } = await import("./TrayambakLogo.js")
    expect(hexToSgr("")).toBeNull()
    expect(hexToSgr("#fff")).toBeNull()
    expect(hexToSgr("rgb(1,2,3)")).toBeNull()
  })
})

describe("padLogoToTheme", () => {
  const art = "\x1b[38;2;1;2;3m\x1b[48;2;4;5;6m▀\x1b[0m\x1b[38;2;1;2;3m\x1b[48;2;4;5;6m▀\x1b[0m"

  it("fills each row with the THEME background, leaving one cell of slack", async () => {
    // The regression this exists for: the raster resets at the end of every
    // row, so the untouched remainder showed the TERMINAL's black as a box.
    // The slack is deliberate: padding to EXACTLY the available width trips
    // Ink's truncator into appending an ellipsis on every banner row.
    const { padLogoToTheme } = await import("./TrayambakLogo.js")
    const padded = padLogoToTheme(art, "#1a1b26", 10)
    const visible = padded.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    expect([...visible].length).toBe(9)
    expect(padded).toContain("\x1b[48;2;26;27;38m")
  })

  it("replaces the row's own uncoloured trailing spaces, never stacks on them", async () => {
    // The bug this pins: the banner's trailing spaces sit BEFORE the closing
    // reset, so they survived the trim and the themed fill landed on top of
    // them — each row ran long by their count and every row got an ellipsis.
    const { padLogoToTheme } = await import("./TrayambakLogo.js")
    const withTrailing = `\x1b[38;2;1;2;3m\x1b[48;2;4;5;6m\u2580\x1b[0m${" ".repeat(20)}\x1b[0m`
    const padded = padLogoToTheme(withTrailing, "#1a1b26", 20)
    const visible = padded.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    expect([...visible].length).toBe(19)
    // Exactly ONE themed fill, and it reaches the end of the row.
    expect(padded.match(/\x1b\[48;2;26;27;38m/g)).toHaveLength(1)
    expect(padded.endsWith("\x1b[0m")).toBe(true)
  })

  it("makes every row of the real banner the same width (no ragged rows)", async () => {
    const { padLogoToTheme } = await import("./TrayambakLogo.js")
    const real = fs.readFileSync(ANSI_LOGO, "utf8").trimEnd()
    const widths = padLogoToTheme(real, "#1a1b26", 114)
      .split("\n")
      .map((l) => [...l.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")].length)
    expect(new Set(widths).size).toBe(1)
    expect(widths[0]).toBe(113)
  })

  it("leaves rows whose art already spans the width untouched", async () => {
    const { padLogoToTheme } = await import("./TrayambakLogo.js")
    // Real ink cells across the whole row (no uncoloured remainder).
    const wide = "\x1b[38;2;1;2;3m\x1b[48;2;4;5;6m" + "\u2580".repeat(10) + "\x1b[0m"
    expect(padLogoToTheme(wide, "#1a1b26", 10)).toBe(wide)
  })

  it("is a no-op without a usable theme colour or width", async () => {
    const { padLogoToTheme } = await import("./TrayambakLogo.js")
    expect(padLogoToTheme(art, "nope", 10)).toBe(art)
    expect(padLogoToTheme(art, "#1a1b26", 0)).toBe(art)
  })
})

describe("baked banner asset renders every row", () => {
  it("emits one rendered line per art row (a single multi-line Text collapses to row 1)", async () => {
    // Regression: wrap="truncate" on ONE multi-line <Text> runs the whole
    // banner through cli-truncate, which flattens it — the 11-row mark showed
    // up as a single stub with a trailing ellipsis.
    const raw = await renderLogo(ANSI_LOGO)
    const art = fs.readFileSync(ANSI_LOGO, "utf8").trimEnd().split("\n")
    const visible = raw
      .split("\n")
      .map((l) => l.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""))
      .filter((l) => l.includes("\u2580") || l.trim() !== "")
    // Every art row that has ink must produce a row carrying a half-block.
    const blockRows = visible.filter((l) => l.includes("\u2580")).length
    expect(blockRows).toBeGreaterThanOrEqual(art.length - 1)
  }, 15000)
})

describe("baked banner asset", () => {
  it("is a half-block raster whose cells are uniform width", () => {
    const raw = fs.readFileSync(ANSI_LOGO, "utf8")
    const rows = raw.trimEnd().split("\n")
    // 11 rows: the reference icon's cloud + stem, sampled at two vertical
    // pixels per row (U+2580), which is what keeps the eye ring readable.
    expect(rows.length).toBe(11)
    for (const line of rows) {
      const visible = line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
      expect([...visible].length).toBeLessThanOrEqual(48)
    }
    expect(raw).toContain("\u2580")
  }, 15000)

  it("closes every row with a reset so no colour bleeds into the next line", () => {
    for (const line of fs.readFileSync(ANSI_LOGO, "utf8").trimEnd().split("\n")) {
      expect(line.endsWith("\x1b[0m")).toBe(true)
    }
  }, 15000)
})

describe("hasAnsi", () => {
  it("detects SGR in the art and its absence in the plain file", async () => {
    const { hasAnsi } = await import("./TrayambakLogo.js")

    expect(hasAnsi("\x1b[38;2;1;2;3mX")).toBe(true)
    expect(hasAnsi("plain text")).toBe(false)
    expect(hasAnsi("")).toBe(false)
  })
})

describe("TrayambakLogo line endings", () => {
  it("never emits a mid-line CR, even from a CRLF copy of the art", async () => {
    const raw = await renderLogoBordered(CRLF_LOGO)

    // A bare \r with printable content after it rewinds Ink's cursor to
    // column 0, which erases the frame's left │ wall and plants a lone │ in
    // the middle of every logo row. (\r\n is the normal line pairing.)
    // Observed: 9 such CRs from 9 interior CRLF endings — one per broken row.
    expect(midLineCarriageReturns(raw)).toBe(0)
  }, 15000)

  it("still paints the art, so the strip only touches line endings", async () => {
    const raw = await renderLogoBordered(CRLF_LOGO)

    expect(fgRuns(raw).length).toBeGreaterThan(0)
    expect(raw).toContain("\x1b[")
  }, 15000)
})
