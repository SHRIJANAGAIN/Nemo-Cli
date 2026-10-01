/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { BOOT_CINE_TICK_MS, bootCineEye, cineTitleHot } from "./BootCine.js"

describe("bootCineEye", () => {
  it("opens in stages: shut, stirring, half, blazing", () => {
    expect(bootCineEye(0)).toMatchObject({ eye: "( - )", showTagline: false })
    expect(bootCineEye(4)).toMatchObject({ eye: "( o )", showTagline: false })
    expect(bootCineEye(8)).toMatchObject({ eye: "( O )", showTagline: false })
    const open = bootCineEye(12)
    expect(open.eye).toBe("( ◉ )")
    expect(open.showTagline).toBe(true)
  })

  it("holds the open eye and tagline afterwards, deterministically", () => {
    expect(bootCineEye(13)).toEqual(bootCineEye(15))
    expect(bootCineEye(100)).toEqual(bootCineEye(12))
  })

  it("ticks briskly (brisk knock, not a movie)", () => {
    expect(BOOT_CINE_TICK_MS).toBeLessThanOrEqual(200)
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
