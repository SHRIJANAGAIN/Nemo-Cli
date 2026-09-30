/* Tests for the SKT AI LABS Code theme port (scripts/convert-skt-themes.mjs output). */
import { describe, expect, it } from "vitest"
import { getTheme, listThemes, setThemeByName } from "./theme.js"
import { SKT_SPECS } from "./skt-themes.js"

const CHECK_KEYS = ["primary", "background", "text", "border", "syntaxKeyword", "diffAddedBg"] as const

describe("skt theme port", () => {
  it("ports all 36 SKT AI LABS Code palettes", () => {
    expect(SKT_SPECS).toHaveLength(36)
  })

  it("merges into the registry (17 bundled + 36 ported = 53)", () => {
    expect(listThemes()).toHaveLength(53)
  })

  it("has no duplicate theme names (no bundled/port collisions)", () => {
    const names = listThemes().map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it("every ported spec builds to a complete dark theme", () => {
    for (const spec of SKT_SPECS) {
      const t = listThemes().find((x) => x.name === spec.name)
      expect(t, `missing theme ${spec.name}`).toBeDefined()
      expect(t!.dark, spec.name).toBe(true)
      for (const k of CHECK_KEYS) {
        const v = t![k]
        for (const ch of ["r", "g", "b"] as const) {
          expect(v[ch], `${spec.name}.${k}.${ch}`).toBeGreaterThanOrEqual(0)
          expect(v[ch], `${spec.name}.${k}.${ch}`).toBeLessThanOrEqual(255)
        }
      }
      expect(t!.thinkingOpacity, spec.name).toBeGreaterThan(0)
      expect(t!.thinkingOpacity, spec.name).toBeLessThanOrEqual(1)
    }
  })

  it("setThemeByName activates a ported theme and restores", () => {
    const prev = getTheme().name
    expect(setThemeByName("dracula")).toBeDefined()
    expect(getTheme().name).toBe("dracula")
    expect(setThemeByName(prev)).toBeDefined()
    expect(getTheme().name).toBe(prev)
  })

  it("keeps the pre-rebrand 'kilo' name resolvable as a legacy alias", () => {
    const prev = getTheme().name
    expect(setThemeByName("kilo")?.name).toBe("solar-stone")
    expect(getTheme().name).toBe("solar-stone")
    expect(setThemeByName(prev)).toBeDefined()
    expect(getTheme().name).toBe(prev)
  })
})
