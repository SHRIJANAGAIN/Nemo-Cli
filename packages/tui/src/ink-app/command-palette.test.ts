/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { buildPaletteRows, filterPaletteEntries, type PaletteEntry } from "./command-palette.js"

const make = (id: string, over: Partial<PaletteEntry> = {}): PaletteEntry => ({
  id,
  title: id,
  category: "Actions",
  run: () => {},
  ...over,
})

describe("filterPaletteEntries", () => {
  it("returns the full list in order for an empty query", () => {
    const entries = [make("one"), make("two"), make("three")]
    expect(filterPaletteEntries(entries, "").map((e) => e.id)).toEqual(["one", "two", "three"])
    expect(filterPaletteEntries(entries, "   ").map((e) => e.id)).toEqual(["one", "two", "three"])
  })

  it("matches case-insensitive subsequences against the title", () => {
    const entries = [make("Theme picker"), make("Abort turn")]
    expect(filterPaletteEntries(entries, "THE").map((e) => e.id)).toEqual(["Theme picker"])
  })

  it("ranks title matches above description-only matches", () => {
    const entries = [
      make("a", {
        title: "compact context",
        description: "prune old history before the mode switch",
      }),
      make("b", { title: "cycle permission mode" }),
    ]
    expect(filterPaletteEntries(entries, "mode").map((e) => e.id)).toEqual(["b", "a"])
  })

  it("drops entries that match nothing", () => {
    const entries = [make("theme picker"), make("abort turn")]
    expect(filterPaletteEntries(entries, "zzqx")).toEqual([])
  })
})

describe("buildPaletteRows", () => {
  it("pins suggested entries under Suggested when the query is empty", () => {
    const entries = [make("one", { suggested: true }), make("two")]
    const rows = buildPaletteRows(entries, "")
    expect(rows.map((r) => r.rowId)).toEqual(["suggested:one", "one", "two"])
    expect(rows[0]?.category).toBe("Suggested")
    expect(rows[1]?.category).toBe("Actions")
  })

  it("drops the Suggested pin while filtering", () => {
    const entries = [make("one", { suggested: true }), make("two")]
    const rows = buildPaletteRows(entries, "one")
    expect(rows.map((r) => r.rowId)).toEqual(["one"])
    expect(rows.some((r) => r.category === "Suggested")).toBe(false)
  })
})
