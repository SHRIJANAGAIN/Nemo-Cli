/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import {
  BLUE_HOT,
  BLUE_RAMP,
  bootCodename,
  bulletLevel,
  GRID_COLS,
  GRID_ROWS,
  gridLevel,
  gridPaint,
  ORBIT_CELLS,
  orbitPaint,
  orbitRowText,
  shimmerLevel,
  shimmerPaint,
  SILVER_GLINT,
  SILVER_HOT,
  SILVER_RAMP,
  silverShade,
} from "./thinking-ribbon.js"

describe("silver ramp", () => {
  it("clamps out-of-range levels instead of returning undefined", () => {
    expect(silverShade(-5)).toBe(SILVER_RAMP[0])
    expect(silverShade(0)).toBe(SILVER_RAMP[0])
    expect(silverShade(SILVER_GLINT)).toBe(SILVER_RAMP[SILVER_GLINT])
    expect(silverShade(99)).toBe(SILVER_RAMP[SILVER_GLINT])
  })

  it("is actually silver (equal r=g=b, dark to light)", () => {
    const lumas = SILVER_RAMP.map((hex) => {
      const n = Number.parseInt(hex.slice(1), 16)
      const r = (n >> 16) & 255
      const g = (n >> 8) & 255
      const b = n & 255
      expect(r, `${hex} red`).toBe(g)
      expect(g, `${hex} green`).toBe(b)
      return r
    })
    for (let i = 1; i < lumas.length; i++) {
      expect(lumas[i] as number, `step ${i}`).toBeGreaterThan(lumas[i - 1] as number)
    }
  })

  it("ends at pure white so the glint has somewhere to go", () => {
    expect(SILVER_RAMP[SILVER_GLINT]).toBe("#ffffff")
    expect(SILVER_HOT).toBeLessThan(SILVER_GLINT)
  })
})

describe("footer square (the old 6-dot braille cluster)", () => {
  it("is always ORBIT_CELLS wide", () => {
    for (let frame = 0; frame < 16; frame++) {
      expect(orbitPaint(frame), `frame ${frame}`).toHaveLength(ORBIT_CELLS)
      expect([...orbitRowText(frame)], `frame ${frame}`).toHaveLength(ORBIT_CELLS)
    }
  })

  it("chases: the brightness travels across ticks", () => {
    const seen = new Set<string>()
    for (let frame = 0; frame < 12; frame++) {
      seen.add(orbitPaint(frame).map((c) => c.color).join(""))
    }
    expect(seen.size).toBeGreaterThan(1)
  })

  it("paints silver only, and the travelling white fires", () => {
    let sawWhite = false
    for (let frame = 0; frame < 24; frame++) {
      for (const cell of orbitPaint(frame)) {
        expect(SILVER_RAMP).toContain(cell.color)
        if (cell.color === SILVER_RAMP[SILVER_GLINT]) sawWhite = true
      }
    }
    expect(sawWhite).toBe(true)
  })

  it("ASCII square stays width-1 per cell", () => {
    for (let frame = 0; frame < 8; frame++) {
      for (const cell of orbitPaint(frame, true)) {
        expect([...cell.glyph], `frame ${frame}`).toHaveLength(1)
      }
    }
  })
})

describe("codex shimmer (brightness band across the label)", () => {
  it("peaks as the band passes and leaves between sweeps", () => {
    const label = "Thinking…"
    // The band must cross index 5 at some point in a full sweep…
    let best = -1
    let bestFrame = 0
    for (let frame = 0; frame < 30; frame++) {
      const t = shimmerLevel(5, label.length, frame)
      if (t > best) {
        best = t
        bestFrame = frame
      }
    }
    expect(best, "band peaks over the text").toBeGreaterThan(0.95)
    // …with cosine falloff on both sides at that moment (symmetric band:
    // equidistant neighbours tie, both at or below the peak)…
    expect(shimmerLevel(4, label.length, bestFrame)).toBeLessThanOrEqual(best)
    expect(shimmerLevel(6, label.length, bestFrame)).toBeLessThanOrEqual(best)
    // …and darkness long before it arrives.
    expect(shimmerLevel(5, label.length, 0)).toBeLessThan(0.5)
    // Full darkness somewhere in every sweep (band fully off-text).
    let darkest = 1
    for (let frame = 0; frame < 30; frame++) {
      darkest = Math.min(darkest, shimmerLevel(5, label.length, frame))
    }
    expect(darkest).toBe(0)
  })

  it("the band travels across ticks (a frozen band is a stuck pixel)", () => {
    const seen = new Set<string>()
    for (let frame = 0; frame < 24; frame++) {
      seen.add(shimmerPaint("Thinking…", frame).map((c) => c.color).join(""))
    }
    expect(seen.size).toBeGreaterThan(1)
  })

  it("empty text paints nothing (no crash on empty labels)", () => {
    expect(shimmerPaint("", 0)).toEqual([])
    expect(shimmerLevel(0, 0, 0)).toBe(0)
  })

  it("never splits graphemes (matras and emoji stay whole)", () => {
    const label = "a\u{1F600}\u{1F469}‍\u{1F4BB}"
    const painted = shimmerPaint(label, 3).map((c) => c.ch).join("")
    expect(painted).toBe(label)
  })

  it("bullet breathes on its own slower cycle", () => {
    const levels = new Set<number>()
    for (let frame = 0; frame < 28; frame++) levels.add(bulletLevel(frame))
    expect(levels.size).toBe(2)
  })
})

describe("thinking eyes (three dots riding the square track)", () => {
  it("paints a literal 3x3 grid", () => {
    for (let frame = 0; frame < 16; frame++) {
      const rows = gridPaint(frame)
      // Literal dims (not constants — a wrong constant passes itself).
      expect(rows, `frame ${frame}`).toHaveLength(3)
      for (const row of rows) {
        expect(row, `frame ${frame}`).toHaveLength(3)
        for (const cell of row) {
          expect(["·", " "]).toContain(cell.glyph)
        }
      }
    }
  })

  it("the head burns white, and every cell lights over a tour (middle too)", () => {
    const everLit = new Set<number>()
    for (let frame = 0; frame < 24; frame++) {
      const rows = gridPaint(frame)
      const colors = rows.flat().map((c) => c.color)
      expect(colors).toContain(BLUE_RAMP[BLUE_HOT])
      rows.flat().forEach((c, i) => {
        if (c.glyph !== " ") everLit.add(i)
      })
    }
    // All nine cells, including the middle (1,1) → index 4.
    expect(everLit.size).toBe(9)
    expect(everLit.has(4)).toBe(true)
  })

  it("the group travels round the track (nothing frozen)", () => {
    const seen = new Set<string>()
    for (let frame = 0; frame < 24; frame++) {
      seen.add(
        gridPaint(frame)
          .flat()
          .map((c) => c.glyph + c.color)
          .join(""),
      )
    }
    expect(seen.size).toBeGreaterThan(1)
  })

  it("runs wandering tours (head visits rim and middle, always forward)", () => {
    // 1 tick per step over the 12-step track: frames 0..11 walk the head
    // through every path stop in order, then wrap.
    const heads: number[] = []
    for (let frame = 0; frame < 12; frame++) {
      let found = -1
      for (let y = 0; y < GRID_ROWS; y++) {
        for (let x = 0; x < GRID_COLS; x++) {
          if (gridLevel(x, y, frame) === BLUE_HOT) found = y * GRID_COLS + x
        }
      }
      heads.push(found)
    }
    // Path order: (0,0)=0, (1,0)=1, (2,0)=2, (2,1)=5, (1,1)=4, (0,1)=3,
    // (0,2)=6, (1,2)=7, (2,2)=8, then revisits 5, 4, 1.
    expect(heads).toEqual([0, 1, 2, 5, 4, 3, 6, 7, 8, 5, 4, 1])
  })

  it("lights two to three dots per frame (trail may share a cell on revisits)", () => {
    for (let frame = 0; frame < 24; frame++) {
      const lit = gridPaint(frame).flat().filter((c) => c.glyph !== " ").length
      expect(lit, `frame ${frame}`).toBeGreaterThanOrEqual(2)
      expect(lit, `frame ${frame}`).toBeLessThanOrEqual(3)
    }
  })

  it("paints blue only \u2014 every colour is on the blue ramp", () => {
    for (let frame = 0; frame < 24; frame++) {
      for (const cell of gridPaint(frame).flat()) {
        expect(BLUE_RAMP).toContain(cell.color)
      }
    }
  })

  it("ascii grid matches (same small dots)", () => {
    const a = gridPaint(5, true).flat().map((c) => c.glyph).join("")
    const b = gridPaint(5).flat().map((c) => c.glyph).join("")
    expect(a).toBe(b)
  })
})

describe("boot codename", () => {
  it("prints the S-series tag alone, never the raw semver", () => {
    expect(bootCodename("1.0.0-S1-TITANIUM")).toBe("S1-TITANIUM")
  })

  it("falls back to a v-prefix for a plain semver build", () => {
    expect(bootCodename("0.6.7")).toBe("v0.6.7")
    expect(bootCodename("v0.6.7")).toBe("v0.6.7")
  })
})