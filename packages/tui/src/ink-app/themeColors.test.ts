/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Colour maths behind the boot cinematic and the banner fade.
 *
 * The load-bearing property: every one of these reads from the ACTIVE theme.
 * The cinematic used to hardcode six hex literals, so on the light palettes
 * (paper-white, sakura-light, orange-light) the dim slate letters were close
 * to invisible against a white terminal.
 */
import { describe, expect, it } from "vitest"
import { cinePalette, logoGradient, mixRgb, parseHex, rgbToHex, bubbleBackground } from "./themeColors.js"
import type { ThemeSnapshot } from "./themeColors.js"
import { listThemes, setThemeByName } from "../ui/theme.js"

function snapshotFor(name: string): ThemeSnapshot {
  setThemeByName(name)
  const theme = listThemes().find((t) => t.name === name)
  if (!theme) throw new Error(`unknown theme: ${name}`)
  return {
    name: theme.name,
    dark: theme.dark,
    primary: rgbToHex(theme.primary),
    secondary: rgbToHex(theme.secondary),
    accent: rgbToHex(theme.accent),
    error: rgbToHex(theme.error),
    warning: rgbToHex(theme.warning),
    success: rgbToHex(theme.success),
    info: rgbToHex(theme.info),
    text: rgbToHex(theme.text),
    textMuted: rgbToHex(theme.textMuted),
    border: rgbToHex(theme.border),
    borderActive: rgbToHex(theme.borderActive),
    background: rgbToHex(theme.background),
    backgroundPanel: rgbToHex(theme.backgroundPanel),
    backgroundElement: rgbToHex(theme.backgroundElement),
    backgroundMenu: rgbToHex(theme.backgroundMenu),
    errorBg: rgbToHex(theme.errorBg),
    successBg: rgbToHex(theme.successBg),
    markdownText: rgbToHex(theme.markdownText),
    markdownHeading: rgbToHex(theme.markdownHeading),
    markdownLink: rgbToHex(theme.markdownLink),
    markdownCode: rgbToHex(theme.markdownCode),
    markdownBlockQuote: rgbToHex(theme.markdownBlockQuote),
    syntaxKeyword: rgbToHex(theme.syntaxKeyword),
    syntaxFunction: rgbToHex(theme.syntaxFunction),
    syntaxString: rgbToHex(theme.syntaxString),
    syntaxNumber: rgbToHex(theme.syntaxNumber),
    syntaxType: rgbToHex(theme.syntaxType),
    syntaxComment: rgbToHex(theme.syntaxComment),
  }
}

describe("parseHex", () => {
  it("round-trips 6-digit hex through rgbToHex", () => {
    expect(rgbToHex(parseHex("#3b7dd8")!)).toBe("#3b7dd8")
  })

  it("expands 3-digit shorthand", () => {
    expect(parseHex("#abc")).toMatchObject({ r: 170, g: 187, b: 204 })
  })

  it("rejects malformed input instead of silently mis-parsing", () => {
    // Matches theme.ts hex(), which throws loudly rather than tolerating
    // named colours and wrong lengths.
    for (const bad of ["", "#", "#12", "#12345", "#gggggg", "red", "#1234567"]) {
      expect(parseHex(bad), bad).toBeUndefined()
    }
  })
})

describe("mixRgb", () => {
  const black = { r: 0, g: 0, b: 0, a: 1 }
  const white = { r: 255, g: 255, b: 255, a: 1 }

  it("returns the endpoints and the midpoint", () => {
    expect(mixRgb(black, white, 0)).toMatchObject({ r: 0, g: 0, b: 0 })
    expect(mixRgb(black, white, 1)).toMatchObject({ r: 255, g: 255, b: 255 })
    expect(mixRgb(black, white, 0.5)).toMatchObject({ r: 128, g: 128, b: 128 })
  })

  it("clamps out-of-range t rather than overshooting the channel range", () => {
    expect(mixRgb(black, white, -5)).toMatchObject({ r: 0, g: 0, b: 0 })
    expect(mixRgb(black, white, 99)).toMatchObject({ r: 255, g: 255, b: 255 })
  })
})

describe("logoGradient", () => {
  it("returns one colour per line", () => {
    expect(logoGradient(snapshotFor("trayambak-dark"), 10)).toHaveLength(10)
  })

  it("starts at the accent and fades toward the body text", () => {
    const theme = snapshotFor("trayambak-dark")
    const gradient = logoGradient(theme, 5)
    expect(gradient[0]).toBe(theme.accent)

    const luminance = (hex: string): number => {
      const { r, g, b } = parseHex(hex)!
      return 0.299 * r + 0.587 * g + 0.114 * b
    }
    // trayambak-dark: accent is dim violet, text is near-white — the fade
    // must get brighter downward or the bottom of the art disappears.
    expect(luminance(gradient[4]!)).toBeGreaterThan(luminance(gradient[0]!))
  })

  it("keeps a single-line banner at the accent instead of dividing by zero", () => {
    const theme = snapshotFor("trayambak-dark")
    expect(logoGradient(theme, 1)).toEqual([theme.accent])
  })

  it("produces no colours for an empty banner", () => {
    expect(logoGradient(snapshotFor("trayambak-dark"), 0)).toEqual([])
  })

  it("falls back to a flat accent when a token will not parse", () => {
    const broken = { ...snapshotFor("trayambak-dark"), accent: "not-a-colour" }
    expect(logoGradient(broken, 3)).toEqual(["not-a-colour", "not-a-colour", "not-a-colour"])
  })

  it("differs between a light and a dark palette", () => {
    const dark = logoGradient(snapshotFor("trayambak-dark"), 4)
    const light = logoGradient(snapshotFor("paper-white"), 4)
    expect(dark).not.toEqual(light)
  })
})

describe("cinePalette", () => {
  it("sources all six slots from theme tokens", () => {
    const theme = snapshotFor("night-sky")
    expect(cinePalette(theme)).toEqual({
      shut: theme.textMuted,
      stirring: theme.secondary,
      half: theme.warning,
      blazing: theme.error,
      hot: theme.warning,
      cold: theme.textMuted,
    })
  })

  it("never emits a hardcoded literal — it tracks whatever theme is active", () => {
    const a = cinePalette(snapshotFor("trayambak-dark"))
    const b = cinePalette(snapshotFor("sakura-light"))
    expect(a).not.toEqual(b)
  })

  it("keeps the sweeping letter distinct from the letters holding dim", () => {
    // matrix-green makes text and warning both green-ish; the sweep must
    // still read as a highlight rather than disappearing into the run.
    const palette = cinePalette(snapshotFor("matrix-green"))
    expect(palette.hot).not.toBe(palette.cold)
  })

  it("resolves on every bundled palette without throwing", () => {
    for (const theme of listThemes()) {
      const palette = cinePalette(snapshotFor(theme.name))
      for (const [slot, value] of Object.entries(palette)) {
        expect(value, `${theme.name}.${slot}`).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })
})

describe("bubbleBackground (user bubble stays visible on every theme)", () => {
  const lum = (hex: string): number => {
    const h = hex.replace("#", "")
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h
    const n = Number.parseInt(full, 16)
    return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)
  }

  it("moves away from the terminal background on every bundled palette", () => {
    // Near-black panels on near-black terminals rendered the bubble
    // invisible (observed live). Blending toward text always steps AWAY
    // from the background the text contrasts against — dark themes step
    // up, light themes step down — so the block reads everywhere.
    for (const theme of listThemes()) {
      const snap = snapshotFor(theme.name)
      const bubble = bubbleBackground(snap.backgroundPanel, snap.text)
      expect(bubble, `${theme.name} hex`).toMatch(/^#[0-9a-f]{6}$/i)
      const panelGap = Math.abs(lum(snap.backgroundPanel) - lum(snap.background))
      const bubbleGap = Math.abs(lum(bubble) - lum(snap.background))
      expect(bubbleGap, `${theme.name} contrast`).toBeGreaterThan(panelGap)
      if (snap.dark) expect(lum(bubble)).toBeGreaterThan(lum(snap.backgroundPanel))
      else expect(lum(bubble)).toBeLessThan(lum(snap.backgroundPanel))
    }
  })

  it("falls back to the panel untouched on malformed input", () => {
    expect(bubbleBackground("not-a-color", "#ffffff")).toBe("not-a-color")
    expect(bubbleBackground("#15141b", "zzz")).toBe("#15141b")
  })
})
