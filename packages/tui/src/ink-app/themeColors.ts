/* themeColors.ts — live bind theme tokens -> hex strings for ink components. */
import { useSyncExternalStore } from "react"
import { getTheme, getThemeVersion, subscribeTheme, type Theme, type Rgb } from "../ui/theme.js"

function rgbToHex(c: Rgb): string {
  return "#" + [c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, "0")).join("")
}

export { rgbToHex }

/** Parse a `#rgb`/`#rrggbb` string back into an {@link Rgb}, or undefined if malformed. */
export function parseHex(value: unknown): Rgb | undefined {
  if (typeof value !== "string") return undefined
  const h = value.replace("#", "")
  if (!/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(h)) return undefined
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h
  const n = Number.parseInt(full, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
}

/** Linear blend between two colours. `t` is clamped to 0..1, so 0 yields `from`. */
export function mixRgb(from: Rgb, to: Rgb, t: number): Rgb {
  const k = Math.min(1, Math.max(0, t))
  const channel = (a: number, b: number): number => Math.round(a + (b - a) * k)
  return { r: channel(from.r, to.r), g: channel(from.g, to.g), b: channel(from.b, to.b), a: 1 }
}

/** User-bubble background: the theme panel mixed toward the text colour so
 *  the block reads on near-black dark themes AND near-white light ones —
 *  panel greys sit within a few levels of the terminal background (observed
 *  live: the bubble was invisible). Blending toward text always moves AWAY
 *  from the background the text must contrast against. Malformed input
 *  falls back to the panel untouched. */
export function bubbleBackground(panelHex: string, textHex: string, amount = 0.18): string {
  const panel = parseHex(panelHex)
  const text = parseHex(textHex)
  if (!panel || !text) return panelHex
  return rgbToHex(mixRgb(panel, text, amount))
}

/** How far the last banner line dissolves into the body text colour. */
const LOGO_FADE = 0.55

/**
 * Per-line colours for a banner that carries no ANSI of its own, fading from
 * the accent at the top into the body text at the bottom.
 *
 * The shipped `logo_ansi.txt` bakes its own palette into the art, so this is
 * only reached when the monochrome fallback file resolves. Without it that
 * path renders flat default-foreground and ignores the active `/theme`.
 *
 * Returns one entry per line. A malformed token falls back to a flat accent
 * rather than an empty array, so callers never have to special-case it.
 */
export function logoGradient(theme: ThemeSnapshot, lineCount: number): string[] {
  if (lineCount <= 0) return []
  const accent = parseHex(theme.accent)
  const text = parseHex(theme.text)
  if (!accent || !text) return new Array<string>(lineCount).fill(theme.accent)
  const last = lineCount - 1
  return Array.from({ length: lineCount }, (_, index) =>
    rgbToHex(mixRgb(accent, text, last === 0 ? 0 : (index / last) * LOGO_FADE)),
  )
}

/** The six paint slots the boot cinematic needs from the active theme. */
export interface CinePalette {
  shut: string
  stirring: string
  half: string
  blazing: string
  /** The one letter burning bright in the title sweep. */
  hot: string
  /** The letters holding dim behind the sweep. */
  cold: string
}

/**
 * Map the active theme onto the boot cinematic's six paint slots.
 *
 * These were hardcoded hex literals, so the splash ignored both the active
 * `/theme` and light/dark mode — the dim slate letters were near-invisible
 * on `paper-white` and `sakura-light`. Token roles preserve the original
 * reading (slate → amber → red) across every bundled palette.
 */
export function cinePalette(theme: ThemeSnapshot): CinePalette {
  return {
    shut: theme.textMuted,
    stirring: theme.secondary,
    half: theme.warning,
    blazing: theme.error,
    hot: theme.warning,
    cold: theme.textMuted,
  }
}

/** Snapshot of the active theme as hex strings (plus the raw theme). */
export interface ThemeSnapshot {
  name: string
  dark: boolean
  primary: string
  secondary: string
  accent: string
  error: string
  warning: string
  success: string
  info: string
  text: string
  textMuted: string
  border: string
  borderActive: string
  background: string
  backgroundPanel: string
  backgroundElement: string
  backgroundMenu: string
  errorBg: string
  successBg: string
  markdownText: string
  markdownHeading: string
  markdownLink: string
  markdownCode: string
  markdownBlockQuote: string
  syntaxKeyword: string
  syntaxFunction: string
  syntaxString: string
  syntaxNumber: string
  syntaxType: string
  syntaxComment: string
}

/** Return the current theme colours as hex. Call inside render (ink re-renders on state change). */
export function useThemeColors(): ThemeSnapshot {
  // Subscribe to the theme version: setThemeByName() bumps it, forcing a
  // re-render that re-reads getTheme() — without this a /theme switch only
  // painted whenever some unrelated state happened to flush.
  useSyncExternalStore(subscribeTheme, getThemeVersion)
  const t: Theme = getTheme()
  return {
    name: t.name,
    dark: t.dark,
    primary: rgbToHex(t.primary),
    secondary: rgbToHex(t.secondary),
    accent: rgbToHex(t.accent),
    error: rgbToHex(t.error),
    warning: rgbToHex(t.warning),
    success: rgbToHex(t.success),
    info: rgbToHex(t.info),
    text: rgbToHex(t.text),
    textMuted: rgbToHex(t.textMuted),
    border: rgbToHex(t.border),
    borderActive: rgbToHex(t.borderActive),
    background: rgbToHex(t.background),
    backgroundPanel: rgbToHex(t.backgroundPanel),
    backgroundElement: rgbToHex(t.backgroundElement),
    backgroundMenu: rgbToHex(t.backgroundMenu),
    errorBg: rgbToHex(t.errorBg),
    successBg: rgbToHex(t.successBg),
    markdownText: rgbToHex(t.markdownText),
    markdownHeading: rgbToHex(t.markdownHeading),
    markdownLink: rgbToHex(t.markdownLink),
    markdownCode: rgbToHex(t.markdownCode),
    markdownBlockQuote: rgbToHex(t.markdownBlockQuote),
    syntaxKeyword: rgbToHex(t.syntaxKeyword),
    syntaxFunction: rgbToHex(t.syntaxFunction),
    syntaxString: rgbToHex(t.syntaxString),
    syntaxNumber: rgbToHex(t.syntaxNumber),
    syntaxType: rgbToHex(t.syntaxType),
    syntaxComment: rgbToHex(t.syntaxComment),
  }
}
