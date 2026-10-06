/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { BOOT_CINE_TICK_MS, bootCineEye, cineCodenameRow, cineTitleColor, cineTitleHot } from "./BootCine.js"
import { bootCodename } from "./thinking-ribbon.js"
import { VERSION } from "../../../../apps/cli/src/version.js"
import type { CinePalette } from "./themeColors.js"

// Distinct sentinels: the point of these tests is that colour comes from the
// palette argument, not from literals baked into the cinematic.
const PALETTE: CinePalette = {
  shut: "#111111",
  stirring: "#222222",
  half: "#333333",
  blazing: "#444444",
  hot: "#555555",
  cold: "#666666",
}

describe("bootCineEye", () => {
  it("opens in stages: shut, stirring, half, blazing", () => {
    expect(bootCineEye(0, PALETTE)).toMatchObject({ eye: "( - )", showTagline: false })
    expect(bootCineEye(4, PALETTE)).toMatchObject({ eye: "( o )", showTagline: false })
    expect(bootCineEye(8, PALETTE)).toMatchObject({ eye: "( O )", showTagline: false })
    const open = bootCineEye(12, PALETTE)
    expect(open.eye).toBe("( ◉ )")
    expect(open.showTagline).toBe(true)
  })

  it("holds the open eye and tagline afterwards, deterministically", () => {
    expect(bootCineEye(13, PALETTE)).toEqual(bootCineEye(15, PALETTE))
    expect(bootCineEye(100, PALETTE)).toEqual(bootCineEye(12, PALETTE))
  })

  it("ticks briskly (brisk knock, not a movie)", () => {
    expect(BOOT_CINE_TICK_MS).toBeLessThanOrEqual(200)
  })

  it("paints every stage from the supplied theme, not baked-in literals", () => {
    const colors = [0, 4, 8, 12].map((frame) => bootCineEye(frame, PALETTE).color)
    expect(colors).toEqual([PALETTE.shut, PALETTE.stirring, PALETTE.half, PALETTE.blazing])
  })

  it("follows a theme switch without remounting", () => {
    const swapped: CinePalette = { ...PALETTE, blazing: "#abcdef" }
    expect(bootCineEye(12, swapped).color).toBe("#abcdef")
  })
})

describe("cineTitleHot", () => {
  it("sweeps one hot letter across the title and wraps", () => {
    expect(cineTitleHot(0, 10)).toBe(0)
    expect(cineTitleHot(9, 10)).toBe(9)
    expect(cineTitleHot(10, 10)).toBe(0)
    expect(cineTitleHot(0, 0)).toBe(0)
  })
})

describe("cineTitleColor", () => {
  it("burns the swept letter hot and holds the rest cold", () => {
    expect(cineTitleColor(3, 3, PALETTE)).toBe(PALETTE.hot)
    expect(cineTitleColor(0, 3, PALETTE)).toBe(PALETTE.cold)
    expect(cineTitleColor(3, 3, PALETTE)).not.toBe(PALETTE.cold)
  })
})

describe("boot codename row", () => {
  const NAME = "S1-TITANIUM"

  it("types the codename in from the left, one char per two ticks", () => {
    // The row is width-reserved, so unrevealed cells are spaces: compare the
    // revealed prefix, not the padded whole.
    expect(cineCodenameRow(0, NAME).join("").trimEnd()).toBe("S")
    expect(cineCodenameRow(2, NAME).join("").trimEnd()).toBe("S1")
    expect(cineCodenameRow(4, NAME).join("").trimEnd()).toBe("S1-")
    expect(cineCodenameRow(6, NAME).join("").trimEnd()).toBe("S1-T")
    // One char per TWO ticks, monotonically — no frame ever reveals nothing
    // new or reveals two at once.
    for (let frame = 1; frame < 40; frame++) {
      const before = cineCodenameRow(frame - 1, NAME).join("").trimEnd().length
      const after = cineCodenameRow(frame, NAME).join("").trimEnd().length
      expect(after - before, `frame ${frame}`).toBeLessThanOrEqual(1)
    }
  })

  it("holds a fixed width before the text lands, so nothing below jumps", () => {
    for (let frame = 0; frame < 24; frame++) {
      expect(cineCodenameRow(frame, NAME), `frame ${frame}`).toHaveLength(NAME.length)
    }
  })

  it("lands the full codename and keeps it on screen", () => {
    // 11 chars at one per two ticks needs frame >= 20; anything past that holds.
    for (const frame of [20, 40, 200]) {
      expect(cineCodenameRow(frame, NAME).join(""), `frame ${frame}`).toBe(NAME)
    }
  })

  it("survives a negative frame and an empty name", () => {
    expect(cineCodenameRow(-4, NAME)).toHaveLength(NAME.length)
    expect(cineCodenameRow(0, "")).toEqual([])
  })

  it("resolves the codename from the real stamped version", () => {
    expect(bootCodename(VERSION)).toBe("S1-TITANIUM")
    expect(bootCodename(VERSION)).not.toContain("1.0.0")
  })
})
