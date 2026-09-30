/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { providerPickerFit } from "./ProviderPicker.js"

/** Row count the picker actually renders inside the App frame, mirroring the
 *  JSX: App border (2) + paddingY (2) + [logo + margin] + title block (3) +
 *  list (window + up/down hints + margin) + footer (1). */
function renderedRows(fit: ReturnType<typeof providerPickerFit>, providerCount: number, logoLines: number): number {
  const hints = (fit.winStart > 0 ? 1 : 0) + (fit.winStart + fit.winSize < providerCount ? 1 : 0)
  const logo = fit.showLogo ? logoLines + 1 : 0
  return 2 + 2 + logo + 3 + fit.winSize + hints + 1 + 1
}

describe("providerPickerFit", () => {
  const ROW_MATRIX = [20, 24, 30, 40, 44, 60]

  it("never exceeds the terminal height — the yoga text-drop regression", () => {
    // At 40 rows the old un-windowed list rendered 39 inner rows against 38
    // available: yoga then blanked individual TEXT lines (title, row 18)
    // while the frame stayed exactly `rows` tall. Strictly-under or bust.
    for (const rows of ROW_MATRIX) {
      for (const selected of [0, 10, 20]) {
        const fit = providerPickerFit({ rows, providerCount: 21, selected, logoLines: 10 })
        expect(renderedRows(fit, 21, 10), `rows=${rows} selected=${selected}`).toBeLessThanOrEqual(rows)
      }
    }
  })

  it("keeps at least one row of slack at the tight sizes", () => {
    for (const rows of [20, 24, 30, 40]) {
      const fit = providerPickerFit({ rows, providerCount: 21, selected: 0, logoLines: 10 })
      expect(rows - renderedRows(fit, 21, 10), `rows=${rows}`).toBeGreaterThanOrEqual(1)
    }
  })

  it("always keeps the selected row inside the window", () => {
    for (const rows of ROW_MATRIX) {
      for (const selected of Array.from({ length: 21 }, (_, i) => i)) {
        const fit = providerPickerFit({ rows, providerCount: 21, selected, logoLines: 10 })
        expect(fit.winStart, `rows=${rows} selected=${selected}`).toBeLessThanOrEqual(selected)
        expect(selected, `rows=${rows} selected=${selected}`).toBeLessThan(fit.winStart + fit.winSize)
      }
    }
  })

  it("windows around a mid-list selection instead of pinning to the head", () => {
    const fit = providerPickerFit({ rows: 40, providerCount: 21, selected: 15, logoLines: 10 })
    expect(fit.winSize).toBe(18)
    expect(fit.winStart).toBe(3) // clamped by the tail, selection still visible
    expect(fit.winStart + fit.winSize).toBe(21)
  })

  it("drops the banner before it squeezes the list (tight terminals)", () => {
    const roomy = providerPickerFit({ rows: 40, providerCount: 21, selected: 0, logoLines: 10 })
    expect(roomy.showLogo).toBe(true)
    const tight = providerPickerFit({ rows: 24, providerCount: 21, selected: 0, logoLines: 10 })
    expect(tight.showLogo).toBe(false)
    expect(tight.winSize).toBe(13)
  })

  it("treats a missing banner file (0 lines) as no banner", () => {
    const fit = providerPickerFit({ rows: 40, providerCount: 21, selected: 0, logoLines: 0 })
    expect(fit.showLogo).toBe(false)
    expect(fit.winSize).toBe(21) // full list fits without the logo eating rows
  })

  it("handles a short provider list without pointless windowing", () => {
    const fit = providerPickerFit({ rows: 40, providerCount: 5, selected: 2, logoLines: 10 })
    expect(fit.winStart).toBe(0)
    expect(fit.winSize).toBe(5)
  })

  it("stays non-negative for an empty list", () => {
    const fit = providerPickerFit({ rows: 40, providerCount: 0, selected: 0, logoLines: 10 })
    expect(fit.winStart).toBeGreaterThanOrEqual(0)
    expect(fit.winSize).toBeGreaterThanOrEqual(1)
  })
})
