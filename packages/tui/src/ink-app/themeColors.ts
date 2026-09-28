/* themeColors.ts — live bind theme tokens -> hex strings for ink components. */
import { useSyncExternalStore } from "react"
import { getTheme, getThemeVersion, subscribeTheme, type Theme, type Rgb } from "../ui/theme.js"

function rgbToHex(c: Rgb): string {
  return "#" + [c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, "0")).join("")
}

export { rgbToHex }

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
