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

  it("keeps the banner a sane size for the welcome frame", async () => {
    // The lockup is wide (ring + gap + TRAYAMBAK CLI wordmark), so the ceiling
    // is set by what a normal terminal can show without truncating the
    // wordmark — crowding out the clock and cwd lines underneath it. 120 is the
    // standard 120-column terminal; beyond that the wordmark would clip.
    const rows = fs.readFileSync(ANSI_LOGO, "utf8").trimEnd().split("\n")
    const widest = Math.max(
      ...rows.map((l) => [...l.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")].length),
    )
    expect(widest).toBeLessThanOrEqual(120)
    expect(rows.length).toBeLessThanOrEqual(16)
  })

  it("leaves rows whose art already spans the width untouched", async () => {
    const { padLogoToTheme } = await import("./TrayambakLogo.js")
    // Real ink cells across the whole row (no uncoloured remainder).
    const wide = "\x1b[38;2;1;2;3m\x1b[48;2;4;5;6m" + "\u2580".repeat(10) + "\x1b[0m"
    expect(padLogoToTheme(wide, "#1a1b26", 10)).toBe(wide)
  })

  it("themes the blanks BETWEEN glyphs, not just the trailing run", async () => {
    // The black band through the wordmark. The banner emits \x1b[0m before
    // every ink cell, and that reset also clears the BACKGROUND, so a space
    // after one fell back to the terminal's black. Filling only the trailing
    // run (as this function used to) left every interior gap black — invisible
    // on a lone hexagon, glaring once the lockup put letters across the row.
    const { padLogoToTheme } = await import("./TrayambakLogo.js")
    const row = "\x1b[0m\x1b[38;2;9;9;9m\u2588 \x1b[0m\x1b[38;2;9;9;9m\u2588\x1b[0m"
    const out = padLogoToTheme(row, "#1a1b26", 20)
    // The interior space must be preceded by a background set, not left bare.
    expect(out).toBe(
      `\x1b[0m\x1b[48;2;26;27;38m\x1b[38;2;9;9;9m\u2588 \x1b[0m\x1b[48;2;26;27;38m\x1b[38;2;9;9;9m\u2588${" ".repeat(16)}\x1b[0m`,
    )
  })

  it("themes every blank on the real lockup, so no cell falls to black", async () => {
    const { padLogoToTheme } = await import("./TrayambakLogo.js")
    const raw = fs.readFileSync(ANSI_LOGO, "utf8")
    const out = padLogoToTheme(raw, "#1a1b26", 120)
    // Walk each row tracking whether a background is active. Any blank cell
    // encountered with no background set is a black pixel on screen.
    for (const line of out.split("\n")) {
      let bg: string | null = null
      for (const m of line.matchAll(/\x1b\[([0-9;]*)m([\s\S]*?)(?=\x1b\[|$)/g)) {
        const sgr = m[1] ?? ""
        if (sgr === "0") bg = null
        else if (sgr.startsWith("48;")) bg = sgr
        for (const ch of m[2] ?? "") {
          // Only blanks matter: an ink cell paints its own foreground and its
          // background is never visible.
          if (ch === " ") {
            expect(bg, `unthemed blank in row: ${JSON.stringify(line.slice(0, 80))}`).not.toBeNull()
          }
        }
      }
    }
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
    const hasInk = (l: string): boolean => [...l].some((c) => INK.test(c))
    const visible = raw
      .split("\n")
      .map((l) => l.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""))
      .filter((l) => hasInk(l) || l.trim() !== "")
    // Every ART row that carries ink must produce a rendered row carrying ink.
    // The generator trims fully blank edge rows, so every art row here carries
    // ink; comparing against the art's own ink-row count (not its total) keeps
    // this honest if that ever changes.
    const artInkRows = art.filter(hasInk).length
    const inkRows = visible.filter(hasInk).length
    expect(inkRows).toBeGreaterThanOrEqual(artInkRows)
  }, 15000)
})

/**
 * Ink glyphs. The mark is drawn procedurally by scripts/make-logo-hex.mjs from
 * quadrant blocks, half blocks and the full block; the earlier braille raster
 * of skt-icon.jpeg is gone. The block ranges are NOT contiguous, so this lists
 * them rather than using one range: U+2580..U+258F (halves + full) and
 * U+2590..U+259F (half column + quadrants).
 */
const INK = /[\u2580-\u258f\u2590-\u259f]/

describe("baked banner asset", () => {
  it("is a procedural wordmark under a starfield, not a sampled raster", () => {
    const raw = fs.readFileSync(ANSI_LOGO, "utf8")
    const rows = raw.trimEnd().split("\n")
    // Rebuilt by scripts/make-logo-hex.mjs: the TRAYAMBAK CLI wordmark from a
    // hand-set bitmap font, under a seeded star scatter. No image, no
    // threshold, so no rim noise is possible — which is what killed the
    // dotted, unstructured look. No dead rows eating frame budget either
    // (dead rows are what push a short viewport's frame past the window and
    // clone it into scrollback).
    expect(rows.length).toBeGreaterThanOrEqual(6)
    expect(rows.length).toBeLessThanOrEqual(10)
    const widest = Math.max(...rows.map((l) => [...l.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")].length))
    // The wordmark plus its sky must still fit a standard terminal so it is
    // never truncated on the welcome screen.
    expect(widest).toBeGreaterThan(60)
    expect(widest).toBeLessThanOrEqual(120)
    // Every ink cell is a full block: letters and stars alike. Anything else
    // (quadrants, halves, braille) is residue of a dead renderer.
    const cells = [...raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")]
    // Newlines survive the strip: they are row separators, not ink.
    const ink = cells.filter((c) => c !== " " && c !== "\n" && c !== "\r")
    expect(ink.length).toBeGreaterThan(100)
    for (const c of ink) expect(c).toBe("\u2588")
    // Nothing from the raster pipeline survives: no braille, no quadrants.
    expect(raw).not.toMatch(/[\u2800-\u28ff]/)
    expect(raw).not.toMatch(/[\u2596-\u259f]/)
  }, 15000)

  it("sets the TRAYAMBAK CLI wordmark as a readable run of full blocks", () => {
    // The wordmark comes from a hand-set 5-row bitmap font, emitted as full
    // blocks only — no sampling, so it is crisp by construction. A sampling
    // path would have letter edges that stair-step like the old raster did.
    const raw = fs.readFileSync(ANSI_LOGO, "utf8")
    const rows = raw.trimEnd().split("\n").map((l) => l.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""))
    // Find the wordmark band: the rows with the widest runs of full blocks.
    const fullBlockRows = rows.filter((l) => l.includes("\u2588\u2588"))
    expect(fullBlockRows.length).toBeGreaterThanOrEqual(3)
    // Every letter of TRAYAMBAK CLI is 4 columns wide with a 2-column gap, so
    // the widest unbroken run of ink is the T's crossbar (4) — no run may be a
    // single stray pixel.
    const widestRun = Math.max(
      ...rows.flatMap((l) => {
        const runs = l.match(/\u2588+/g) ?? []
        return runs.map((r) => r.length)
      }),
    )
    expect(widestRun).toBeGreaterThanOrEqual(4)
  }, 15000)

  it("leaves isolation to the stars: detached cells are full blocks only", () => {
    // The starfield is SUPPOSED to be detached — lone dots in the dark. What
    // must never come back is the raster's partial-cell speckle (a stair-step
    // edge fragment reads as a half quadrant, never a clean full block), so
    // every neighbourless cell has to be a full block.
    const chars = fs
      .readFileSync(ANSI_LOGO, "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => [...l.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")])
    const grid = chars.map((row) => row.map((ch) => INK.test(ch)))
    const rows = grid.length
    const cols = Math.max(...grid.map((r) => r.length))
    const lit = (r: number, c: number): boolean =>
      r < 0 || r >= rows || c < 0 || c >= cols ? false : (grid[r]![c] ?? false)
    let litCells = 0
    const isolated: string[] = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!lit(r, c)) continue
        litCells++
        let neighbours = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dy === 0 && dx === 0) continue
            if (lit(r + dy, c + dx)) neighbours++
          }
        }
        if (neighbours === 0) isolated.push(chars[r]![c]!)
      }
    }
    expect(litCells).toBeGreaterThan(50)
    expect(isolated.length).toBeGreaterThan(0)
    for (const ch of isolated) expect(ch).toBe("\u2588")
  }, 15000)

  it("scatters a real starfield above the wordmark", () => {
    // The sky band (rows above the wordmark) must carry detached bright
    // cells, and the wordmark band must carry the dense letterforms. A
    // regeneration that dropped the scatter (or flooded the sky solid) would
    // read as a plain banner — this pins both halves of the composition.
    const raw = fs.readFileSync(ANSI_LOGO, "utf8")
    const rows = raw.trimEnd().split("\n").map((l) => l.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""))
    // Wordmark band: the last 5 rows, dense with full blocks.
    const wordRows = rows.slice(-5)
    const wordInk = wordRows.flatMap((l) => [...l]).filter((c) => c === "\u2588").length
    expect(wordInk).toBeGreaterThan(100)
    // Sky band: everything above it, sparse by design — some ink, mostly dark.
    const skyRows = rows.slice(0, -5)
    expect(skyRows.length).toBeGreaterThanOrEqual(2)
    const skyInk = skyRows.flatMap((l) => [...l]).filter((c) => c === "\u2588").length
    const skyCells = skyRows.flatMap((l) => [...l]).length
    expect(skyInk).toBeGreaterThan(5)
    expect(skyInk / Math.max(1, skyCells)).toBeLessThan(0.3)
  }, 15000)

  it("does not flood the outer rows", () => {
    const perRow = fs
      .readFileSync(ANSI_LOGO, "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => [...l.matchAll(/\u2588/g)].length)
    const widest = Math.max(...perRow)
    // The generator trims fully blank edge rows, so the first and last asset
    // rows carry ink — but never a slab across the whole banner. A fully
    // inked row is the flood signature (the old erode/dilate bug filled the
    // top and bottom rows solid once).
    expect(perRow[0]).toBeGreaterThan(0)
    expect(perRow[perRow.length - 1]).toBeGreaterThan(0)
    expect(perRow[0]).toBeLessThan(widest)
    expect(perRow[perRow.length - 1]).toBeLessThan(widest)
    // The mark occupies the frame, never the whole width.
    expect(widest).toBeLessThan(120)
  }, 15000)

  it("draws straight strokes as full runs, not as slivers", () => {
    // Every letter comes from the bitmap font snapped to whole cells, so a
    // horizontal bar prints as full blocks. A sampling path would print
    // halves (`▢▢▢▢`) instead.
    //
    // The floor is the T's crossbar: 4 cells wide. A sliver render would
    // produce runs of 1.
    let best = 0
    for (const line of fs.readFileSync(ANSI_LOGO, "utf8").trimEnd().split("\n")) {
      let run = 0
      let bestRun = 0
      for (const ch of line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")) {
        run = ch === "\u2588" ? run + 1 : 0
        if (run > bestRun) bestRun = run
      }
      if (bestRun > best) best = bestRun
    }
    // The T's crossbar reaches 4 cells. A sliver render would produce runs
    // of 1.
    expect(best).toBeGreaterThanOrEqual(4)
  }, 15000)

  it("uses an all-metal palette: every colour is near-neutral silver", () => {
    const raw = fs.readFileSync(ANSI_LOGO, "utf8")
    // No white interior pass — that was the speckled-outline rule from the
    // raster days.
    expect(raw).not.toContain("38;2;245;248;252m")
    expect(raw).not.toContain("48;2;245;248;252m")
    const cells = [...raw.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m[\u2588\u2596-\u259f]/g)]
    expect(cells.length).toBeGreaterThan(100)
    for (const m of cells) {
      const r = Number(m[1])
      const g = Number(m[2])
      const b = Number(m[3])
      // Silver/steel: the three channels sit within a small band of each other.
      // A tinted colour (the old blue gradient, the cyan monogram) fails here,
      // which is what pins "silver only".
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(40)
      // …and nothing is so dark it reads as a separate colour against the
      // theme background.
      expect(Math.min(r, g, b)).toBeGreaterThanOrEqual(70)
    }
  }, 15000)

  it("closes every row with a reset so no colour bleeds into the next line", () => {
    for (const line of fs.readFileSync(ANSI_LOGO, "utf8").trimEnd().split("\n")) {
      expect(line.endsWith("\x1b[0m")).toBe(true)
    }
  }, 15000)
})

describe("logoShimmer", () => {
  // The mark is drawn from full blocks, so the twinkle's cell pattern must
  // match that range — targeting anything else leaves cells unrecoloured and
  // the idle animation silently does nothing on them.
  const art = "\x1b[38;2;100;150;200m\u2588\x1b[0m\n\x1b[38;2;230;238;248m\u2588\x1b[0m"

  it("returns the art untouched at phase 0 (static rendering is exact)", async () => {
    const { logoShimmer } = await import("./TrayambakLogo.js")
    expect(logoShimmer(art, 0)).toBe(art)
  })

  it("keeps every block glyph and the row count while recolouring", async () => {
    const { logoShimmer } = await import("./TrayambakLogo.js")
    const out = logoShimmer(art, 1500)
    expect(out.split("\n")).toHaveLength(2)
    expect(out.split("\u2588").length - 1).toBe(2)
  })

  it("twinkles bright cells harder than dim ones", async () => {
    // The twinkle scales each cell by its own brightness: the dim steel cell
    // breathes, the near-white spark flashes. Same phase, both move — but the
    // bright one moves more. That gradient is what reads as depth.
    //
    // Phase 4500 sits on the dimming slope (sin < 0), where no channel can
    // clip at 255: on the brightening slope the spark would pin at max white
    // and read as a smaller shift than it really is.
    const { logoShimmer } = await import("./TrayambakLogo.js")
    const shiftOf = (art: string): number => {
      const before = [...art.matchAll(/\x1b\[38;2;(\d+);\d+;\d+m/g)].map((m) => Number(m[1]))
      const after = [...logoShimmer(art, 4500).matchAll(/\x1b\[38;2;(\d+);\d+;\d+m/g)].map(
        (m) => Number(m[1]),
      )
      expect(before).toHaveLength(1)
      expect(after).toHaveLength(1)
      return Math.abs(after[0]! - before[0]!) / before[0]!
    }
    const dimShift = shiftOf("\x1b[38;2;100;150;200m\u2588\x1b[0m")
    const brightShift = shiftOf("\x1b[38;2;230;238;248m\u2588\x1b[0m")
    expect(brightShift).toBeGreaterThan(dimShift)
    expect(brightShift).toBeLessThanOrEqual(0.23)
  })

  it("actually recolours the shipped asset's cells", async () => {
    // Regression: the shimmer's cell pattern targeted braille while the mark
    // is drawn in quadrant/half blocks, so it matched nothing and the idle
    // animation was a silent no-op on every real frame.
    const { logoShimmer } = await import("./TrayambakLogo.js")
    const raw = fs.readFileSync(ANSI_LOGO, "utf8")
    const before = [...raw.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)]
    expect(before.length).toBeGreaterThan(20)
    const out = logoShimmer(raw, 1500)
    const after = [...out.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)]
    expect(after).toHaveLength(before.length)
    // At least one channel must actually differ, or nothing is animating.
    const changed = after.some(
      (m, i) =>
        Number(m[1]) !== Number(before[i]![1]) ||
        Number(m[2]) !== Number(before[i]![2]) ||
        Number(m[3]) !== Number(before[i]![3]),
    )
    expect(changed).toBe(true)
  }, 15000)

  it("never pushes a channel out of the 0-255 range", async () => {
    const { logoShimmer } = await import("./TrayambakLogo.js")
    for (const phase of [0, 750, 1500, 3000, 4500, 5999]) {
      for (const m of logoShimmer(art, phase).matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)) {
        for (const n of m.slice(1)) {
          const v = Number(n)
          expect(v).toBeGreaterThanOrEqual(0)
          expect(v).toBeLessThanOrEqual(255)
        }
      }
    }
  })

  it("stays subtle: the shift is bounded, not a light show", async () => {
    const { logoShimmer } = await import("./TrayambakLogo.js")
    const before = [...art.matchAll(/\x1b\[38;2;(\d+);\d+;\d+m/g)].map((m) => Number(m[1]))
    const after = [...logoShimmer(art, 3000).matchAll(/\x1b\[38;2;(\d+);\d+;\d+m/g)].map((m) => Number(m[1]))
    expect(after).toHaveLength(before.length)
    // Amplitude 0.22 at full luminance, plus rounding: the wordmark breathes,
    // nothing strobes.
    for (let i = 0; i < before.length; i++) {
      expect(Math.abs(after[i]! - before[i]!)).toBeLessThanOrEqual(Math.round(before[i]! * 0.22) + 1)
    }
  })
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
