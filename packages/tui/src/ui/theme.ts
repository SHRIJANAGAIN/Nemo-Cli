/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * TRAYAMBAK TUI — full theme system.
 * Token-based color themes with truecolor ANSI output,
 * luminance-aware selection foreground, and bundled palettes.
 */

import { SKT_SPECS } from "./skt-themes.js"
import npmStringWidth from "string-width"

export type Rgb = { r: number; g: number; b: number; a?: number }

function hex(s: string): Rgb {
  const h = s.replace("#", "")
  // Strict 3/6 hex only: "#RGBA"/"#RRGGBBAA"/named colors used to parse
  // silently into wrong colors (parseInt tolerates garbage + wrong lengths
  // shift the channels). Fail loud on anything else.
  if (!/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(h)) {
    throw new Error(`invalid hex color: ${JSON.stringify(s)}`)
  }
  const n = parseInt(
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h,
    16,
  )
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
}

export type Theme = {
  readonly name: string
  readonly dark: boolean
  readonly primary: Rgb
  readonly secondary: Rgb
  readonly accent: Rgb
  readonly error: Rgb
  readonly warning: Rgb
  readonly success: Rgb
  readonly info: Rgb
  readonly text: Rgb
  readonly textMuted: Rgb
  readonly selectedListItemText: Rgb
  readonly background: Rgb
  readonly backgroundPanel: Rgb
  readonly backgroundElement: Rgb
  readonly backgroundMenu: Rgb
  readonly border: Rgb
  readonly borderActive: Rgb
  readonly borderSubtle: Rgb
  readonly diffAdded: Rgb
  readonly diffRemoved: Rgb
  readonly diffContext: Rgb
  readonly diffHunkHeader: Rgb
  readonly diffHighlightAdded: Rgb
  readonly diffHighlightRemoved: Rgb
  readonly diffAddedBg: Rgb
  readonly diffRemovedBg: Rgb
  readonly diffContextBg: Rgb
  readonly errorBg: Rgb
  readonly successBg: Rgb
  readonly diffLineNumber: Rgb
  readonly diffAddedLineNumberBg: Rgb
  readonly diffRemovedLineNumberBg: Rgb
  readonly markdownText: Rgb
  readonly markdownHeading: Rgb
  readonly markdownLink: Rgb
  readonly markdownLinkText: Rgb
  readonly markdownCode: Rgb
  readonly markdownBlockQuote: Rgb
  readonly markdownEmph: Rgb
  readonly markdownStrong: Rgb
  readonly markdownHorizontalRule: Rgb
  readonly markdownListItem: Rgb
  readonly markdownListEnumeration: Rgb
  readonly markdownImage: Rgb
  readonly markdownImageText: Rgb
  readonly markdownCodeBlock: Rgb
  readonly syntaxComment: Rgb
  readonly syntaxKeyword: Rgb
  readonly syntaxFunction: Rgb
  readonly syntaxVariable: Rgb
  readonly syntaxString: Rgb
  readonly syntaxNumber: Rgb
  readonly syntaxType: Rgb
  readonly syntaxOperator: Rgb
  readonly syntaxPunctuation: Rgb
  readonly thinkingOpacity: number
}

export type PaletteSpec = {
  name: string
  dark: boolean
  c: Record<string, string>
  thinkingOpacity?: number
}

/** Build a full Theme from a compact palette spec (missing tokens fall back sensibly). */
function build(spec: PaletteSpec): Theme {
  const c = spec.c
  const g = (k: string, fb: string): Rgb => hex(c[k] ?? c[fb] ?? "#cccccc")
  const border = g("border", "borderSubtle")
  return {
    name: spec.name,
    dark: spec.dark,
    primary: g("primary", "secondary"),
    secondary: g("secondary", "primary"),
    accent: g("accent", "secondary"),
    error: g("error", "warning"),
    warning: g("warning", "error"),
    success: g("success", "info"),
    info: g("info", "success"),
    text: g("text", "textMuted"),
    textMuted: g("textMuted", "text"),
    selectedListItemText: g("selectedListItemText", "background"),
    background: g("background", "backgroundPanel"),
    backgroundPanel: g("backgroundPanel", "background"),
    backgroundElement: g("backgroundElement", "backgroundPanel"),
    backgroundMenu: g("backgroundMenu", "backgroundPanel"),
    border,
    borderActive: g("borderActive", "border"),
    borderSubtle: g("borderSubtle", "border"),
    diffAdded: g("diffAdded", "success"),
    diffRemoved: g("diffRemoved", "error"),
    diffContext: g("diffContext", "textMuted"),
    diffHunkHeader: g("diffHunkHeader", "info"),
    diffHighlightAdded: g("diffHighlightAdded", "diffAdded"),
    diffHighlightRemoved: g("diffHighlightRemoved", "diffRemoved"),
    diffAddedBg: g("diffAddedBg", "backgroundElement"),
    diffRemovedBg: g("diffRemovedBg", "backgroundElement"),
    diffContextBg: g("diffContextBg", "background"),
    errorBg: g("errorBg", "backgroundElement"),
    successBg: g("successBg", "backgroundElement"),
    diffLineNumber: g("diffLineNumber", "textMuted"),
    diffAddedLineNumberBg: g("diffAddedLineNumberBg", "diffAddedBg"),
    diffRemovedLineNumberBg: g("diffRemovedLineNumberBg", "diffRemovedBg"),
    markdownText: g("markdownText", "text"),
    markdownHeading: g("markdownHeading", "primary"),
    markdownLink: g("markdownLink", "info"),
    markdownLinkText: g("markdownLinkText", "markdownLink"),
    markdownCode: g("markdownCode", "accent"),
    markdownBlockQuote: g("markdownBlockQuote", "textMuted"),
    markdownEmph: g("markdownEmph", "text"),
    markdownStrong: g("markdownStrong", "text"),
    markdownHorizontalRule: g("markdownHorizontalRule", "border"),
    markdownListItem: g("markdownListItem", "primary"),
    markdownListEnumeration: g("markdownListEnumeration", "secondary"),
    markdownImage: g("markdownImage", "markdownLink"),
    markdownImageText: g("markdownImageText", "markdownLinkText"),
    markdownCodeBlock: g("markdownCodeBlock", "markdownCode"),
    syntaxComment: g("syntaxComment", "textMuted"),
    syntaxKeyword: g("syntaxKeyword", "primary"),
    syntaxFunction: g("syntaxFunction", "info"),
    syntaxVariable: g("syntaxVariable", "text"),
    syntaxString: g("syntaxString", "success"),
    syntaxNumber: g("syntaxNumber", "warning"),
    syntaxType: g("syntaxType", "accent"),
    syntaxOperator: g("syntaxOperator", "primary"),
    syntaxPunctuation: g("syntaxPunctuation", "textMuted"),
    thinkingOpacity: spec.thinkingOpacity ?? 0.55,
  }
}

// -- Bundled palettes (rebranded) ---------------------------------------------

const TRAYAMBAK_DARK = build({
  name: "trayambak-dark",
  dark: true,
  c: {
    primary: "#6cb6f5",
    secondary: "#5c9cf5",
    accent: "#9d7cd8",
    error: "#e06c75",
    warning: "#f5a742",
    success: "#7fd88f",
    info: "#56b6c2",
    text: "#eeeeee",
    textMuted: "#808080",
    selectedListItemText: "#0a0a0a",
    background: "#0a0a0a",
    backgroundPanel: "#141414",
    backgroundElement: "#1e1e1e",
    backgroundMenu: "#282828",
    border: "#3c3c3c",
    borderActive: "#606060",
    borderSubtle: "#282828",
    errorBg: "#3a1418",
    successBg: "#123318",
    diffAdded: "#7fd88f",
    diffRemoved: "#e06c75",
    diffContext: "#808080",
    diffAddedBg: "#123318",
    diffRemovedBg: "#3a1418",
    diffContextBg: "#0a0a0a",
    diffAddedLineNumberBg: "#0f2413",
    diffRemovedLineNumberBg: "#26100f",
    syntaxComment: "#808080",
    syntaxKeyword: "#6cb6f5",
    syntaxFunction: "#56b6c2",
    syntaxString: "#7fd88f",
    syntaxNumber: "#f5a742",
    syntaxType: "#9d7cd8",
    syntaxOperator: "#5c9cf5",
  },
})

const NIGHT_SKY = build({
  name: "night-sky",
  dark: true,
  c: {
    primary: "#82aaff",
    secondary: "#c792ea",
    accent: "#f78c6c",
    error: "#ff5370",
    warning: "#ffcb6b",
    success: "#c3e88d",
    info: "#89ddff",
    text: "#d6deeb",
    textMuted: "#637777",
    selectedListItemText: "#011627",
    background: "#011627",
    backgroundPanel: "#0b2942",
    backgroundElement: "#122d42",
    backgroundMenu: "#10263c",
    border: "#1d3b53",
    borderActive: "#3e5a75",
    borderSubtle: "#152c40",
    errorBg: "#5c1a26",
    successBg: "#1a3d1a",
    syntaxComment: "#637777",
    syntaxKeyword: "#c792ea",
    syntaxFunction: "#82aaff",
    syntaxString: "#c3e88d",
    syntaxNumber: "#f78c6c",
    syntaxType: "#ffcb6b",
    syntaxOperator: "#82aaff",
  },
})

const OCEAN_DEEP = build({
  name: "ocean-deep",
  dark: true,
  c: {
    primary: "#88c0d0",
    secondary: "#81a1c1",
    accent: "#b48ead",
    error: "#bf616a",
    warning: "#ebcb8b",
    success: "#a3be8c",
    info: "#8fbcbb",
    text: "#eceff4",
    textMuted: "#616e88",
    selectedListItemText: "#2e3440",
    background: "#2e3440",
    backgroundPanel: "#3b4252",
    backgroundElement: "#434c5e",
    backgroundMenu: "#4c566a",
    border: "#4c566a",
    borderActive: "#616e88",
    borderSubtle: "#3b4252",
    syntaxComment: "#616e88",
    syntaxKeyword: "#81a1c1",
    syntaxFunction: "#88c0d0",
    syntaxString: "#a3be8c",
    syntaxNumber: "#b48ead",
    syntaxType: "#8fbcbb",
    syntaxOperator: "#81a1c1",
  },
})

const FOREST_CAMP = build({
  name: "forest-camp",
  dark: true,
  c: {
    primary: "#a9b665",
    secondary: "#7daea3",
    accent: "#d8a657",
    error: "#e78a4e",
    warning: "#d8a657",
    success: "#a9b665",
    info: "#7daea3",
    text: "#d4be98",
    textMuted: "#7c6f64",
    selectedListItemText: "#282828",
    background: "#282828",
    backgroundPanel: "#32302f",
    backgroundElement: "#3c3836",
    backgroundMenu: "#45403d",
    border: "#45403d",
    borderActive: "#7c6f64",
    borderSubtle: "#3c3836",
    syntaxComment: "#7c6f64",
    syntaxKeyword: "#d8a657",
    syntaxFunction: "#7daea3",
    syntaxString: "#a9b665",
    syntaxNumber: "#e78a4e",
    syntaxType: "#d3869b",
    syntaxOperator: "#a9b665",
  },
})

const CANDY_POP = build({
  name: "candy-pop",
  dark: true,
  c: {
    primary: "#f5c2e7",
    secondary: "#89b4fa",
    accent: "#f9e2af",
    error: "#f38ba8",
    warning: "#fab387",
    success: "#a6e3a1",
    info: "#94e2d5",
    text: "#cdd6f4",
    textMuted: "#7f849c",
    selectedListItemText: "#1e1e2e",
    background: "#1e1e2e",
    backgroundPanel: "#181825",
    backgroundElement: "#313244",
    backgroundMenu: "#45475a",
    border: "#45475a",
    borderActive: "#7f849c",
    borderSubtle: "#313244",
    syntaxComment: "#7f849c",
    syntaxKeyword: "#cba6f7",
    syntaxFunction: "#89b4fa",
    syntaxString: "#a6e3a1",
    syntaxNumber: "#fab387",
    syntaxType: "#f5c2e7",
    syntaxOperator: "#89b4fa",
  },
})

const PAPER_WHITE = build({
  name: "paper-white",
  dark: false,
  c: {
    primary: "#3b7dd8",
    secondary: "#7b5bb6",
    accent: "#d68c27",
    error: "#d1383d",
    warning: "#b0851f",
    success: "#3d9a57",
    info: "#318795",
    text: "#1a1a1a",
    textMuted: "#8a8a8a",
    selectedListItemText: "#ffffff",
    background: "#ffffff",
    backgroundPanel: "#fafafa",
    backgroundElement: "#ebebeb",
    backgroundMenu: "#d4d4d4",
    border: "#d4d4d4",
    borderActive: "#b8b8b8",
    borderSubtle: "#e1e1e1",
    syntaxComment: "#8a8a8a",
    syntaxKeyword: "#3b7dd8",
    syntaxFunction: "#318795",
    syntaxString: "#3d9a57",
    syntaxNumber: "#b0851f",
    syntaxType: "#7b5bb6",
    syntaxOperator: "#3b7dd8",
  },
})

const MATRIX_GREEN = build({
  name: "matrix-green",
  dark: true,
  c: {
    primary: "#00ff41",
    secondary: "#008f11",
    accent: "#00cc33",
    error: "#ff3333",
    warning: "#ffaa00",
    success: "#00ff41",
    info: "#00cccc",
    text: "#00ff41",
    textMuted: "#007a1f",
    selectedListItemText: "#000000",
    background: "#000000",
    backgroundPanel: "#0a0f0a",
    backgroundElement: "#0d1a0d",
    backgroundMenu: "#122412",
    border: "#0f3f0f",
    borderActive: "#00aa2e",
    borderSubtle: "#0a200a",
    syntaxComment: "#007a1f",
    syntaxKeyword: "#00ff41",
    syntaxFunction: "#00cc33",
    syntaxString: "#aaffaa",
    syntaxNumber: "#ffaa00",
    syntaxType: "#00cccc",
    syntaxOperator: "#00ff41",
  },
})

const CRIMSON_DUSK = build({
  name: "crimson-dusk",
  dark: true,
  c: {
    primary: "#ff6b6b",
    secondary: "#c56cf0",
    accent: "#ffd32a",
    error: "#ff4757",
    warning: "#ffa502",
    success: "#7bed9f",
    info: "#70a1ff",
    text: "#f1f2f6",
    textMuted: "#747d8c",
    selectedListItemText: "#1e1e2f",
    background: "#1e1e2f",
    backgroundPanel: "#252540",
    backgroundElement: "#2d2d50",
    backgroundMenu: "#36365e",
    border: "#3d3d6b",
    borderActive: "#5f5f9e",
    borderSubtle: "#2d2d50",
    syntaxComment: "#747d8c",
    syntaxKeyword: "#ff6b6b",
    syntaxFunction: "#70a1ff",
    syntaxString: "#7bed9f",
    syntaxNumber: "#ffd32a",
    syntaxType: "#c56cf0",
    syntaxOperator: "#ff6b6b",
  },
})

const SUNSET_AMBER = build({
  name: "sunset-amber",
  dark: true,
  c: {
    primary: "#ff9f43",
    secondary: "#54a0ff",
    accent: "#ee5253",
    error: "#ee5253",
    warning: "#ff9f43",
    success: "#10ac84",
    info: "#48dbfb",
    text: "#f5f6fa",
    textMuted: "#8395a7",
    selectedListItemText: "#1e272e",
    background: "#1e272e",
    backgroundPanel: "#26323d",
    backgroundElement: "#2f3e4c",
    backgroundMenu: "#384a5b",
    border: "#384a5b",
    borderActive: "#5c7080",
    borderSubtle: "#2f3e4c",
    syntaxComment: "#8395a7",
    syntaxKeyword: "#ff9f43",
    syntaxFunction: "#48dbfb",
    syntaxString: "#10ac84",
    syntaxNumber: "#ee5253",
    syntaxType: "#54a0ff",
    syntaxOperator: "#ff9f43",
  },
})

const SAKURA_LIGHT = build({
  name: "sakura-light",
  dark: false,
  c: {
    primary: "#d6336c",
    secondary: "#7048e8",
    accent: "#f59f00",
    error: "#e03131",
    warning: "#f08c00",
    success: "#2f9e44",
    info: "#1971c2",
    text: "#212529",
    textMuted: "#868e96",
    selectedListItemText: "#fff0f6",
    background: "#fff0f6",
    backgroundPanel: "#fff5fa",
    backgroundElement: "#fdeef5",
    backgroundMenu: "#f9d8e5",
    border: "#f9d8e5",
    borderActive: "#e6a3c0",
    borderSubtle: "#fce4ee",
    syntaxComment: "#868e96",
    syntaxKeyword: "#7048e8",
    syntaxFunction: "#1971c2",
    syntaxString: "#2f9e44",
    syntaxNumber: "#f59f00",
    syntaxType: "#d6336c",
    syntaxOperator: "#d6336c",
  },
})

const CARBON_STEEL = build({
  name: "carbon-steel",
  dark: true,
  c: {
    primary: "#61dafb",
    secondary: "#a6accd",
    accent: "#e6a700",
    error: "#f07178",
    warning: "#e6a700",
    success: "#7fd962",
    info: "#59c2ff",
    text: "#a6accd",
    textMuted: "#575f85",
    selectedListItemText: "#09090d",
    background: "#09090d",
    backgroundPanel: "#101017",
    backgroundElement: "#191924",
    backgroundMenu: "#22222f",
    border: "#262635",
    borderActive: "#414863",
    borderSubtle: "#191924",
    syntaxComment: "#575f85",
    syntaxKeyword: "#f07178",
    syntaxFunction: "#59c2ff",
    syntaxString: "#7fd962",
    syntaxNumber: "#e6a700",
    syntaxType: "#c792ea",
    syntaxOperator: "#61dafb",
  },
})

const MONO_GRAY = build({
  name: "mono-gray",
  dark: true,
  c: {
    primary: "#eeeeee",
    secondary: "#a0a0a0",
    accent: "#c0c0c0",
    error: "#eeeeee",
    warning: "#c0c0c0",
    success: "#eeeeee",
    info: "#a0a0a0",
    text: "#eeeeee",
    textMuted: "#808080",
    selectedListItemText: "#0a0a0a",
    background: "#0a0a0a",
    backgroundPanel: "#141414",
    backgroundElement: "#1e1e1e",
    backgroundMenu: "#282828",
    border: "#3c3c3c",
    borderActive: "#606060",
    borderSubtle: "#282828",
    syntaxComment: "#808080",
    syntaxKeyword: "#eeeeee",
    syntaxFunction: "#c0c0c0",
    syntaxString: "#eeeeee",
    syntaxNumber: "#c0c0c0",
    syntaxType: "#a0a0a0",
    syntaxOperator: "#eeeeee",
  },
})

const VELVET_PURPLE = build({
  name: "velvet-purple",
  dark: true,
  c: {
    primary: "#b388ff",
    secondary: "#80d8ff",
    accent: "#ff8a80",
    error: "#ff5252",
    warning: "#ffd740",
    success: "#69f0ae",
    info: "#40c4ff",
    text: "#e8e0f0",
    textMuted: "#7a6f8f",
    selectedListItemText: "#15101f",
    background: "#15101f",
    backgroundPanel: "#1d1630",
    backgroundElement: "#261d40",
    backgroundMenu: "#302450",
    border: "#302450",
    borderActive: "#5a4a8a",
    borderSubtle: "#261d40",
    syntaxComment: "#7a6f8f",
    syntaxKeyword: "#b388ff",
    syntaxFunction: "#80d8ff",
    syntaxString: "#69f0ae",
    syntaxNumber: "#ffd740",
    syntaxType: "#ff8a80",
    syntaxOperator: "#b388ff",
  },
})

const EVERGREEN = build({
  name: "evergreen",
  dark: true,
  c: {
    primary: "#83c092",
    secondary: "#7fbbb3",
    accent: "#dbbc7f",
    error: "#e67e80",
    warning: "#dbbc7f",
    success: "#a7c080",
    info: "#7fbbb3",
    text: "#d3c6aa",
    textMuted: "#859289",
    selectedListItemText: "#2d353b",
    background: "#2d353b",
    backgroundPanel: "#343f44",
    backgroundElement: "#3d484d",
    backgroundMenu: "#475258",
    border: "#475258",
    borderActive: "#859289",
    borderSubtle: "#3d484d",
    syntaxComment: "#859289",
    syntaxKeyword: "#e67e80",
    syntaxFunction: "#7fbbb3",
    syntaxString: "#a7c080",
    syntaxNumber: "#dbbc7f",
    syntaxType: "#d699b6",
    syntaxOperator: "#83c092",
  },
})

const ARCTIC_FOX = build({
  name: "arctic-fox",
  dark: true,
  c: {
    primary: "#85ccff",
    secondary: "#94e2b8",
    accent: "#ffd699",
    error: "#ff7b72",
    warning: "#ffd699",
    success: "#94e2b8",
    info: "#85ccff",
    text: "#c9d1d9",
    textMuted: "#8b949e",
    selectedListItemText: "#0d1117",
    background: "#0d1117",
    backgroundPanel: "#161b22",
    backgroundElement: "#21262d",
    backgroundMenu: "#292e36",
    border: "#30363d",
    borderActive: "#8b949e",
    borderSubtle: "#21262d",
    syntaxComment: "#8b949e",
    syntaxKeyword: "#ff7b72",
    syntaxFunction: "#85ccff",
    syntaxString: "#94e2b8",
    syntaxNumber: "#ffd699",
    syntaxType: "#d2a8ff",
    syntaxOperator: "#85ccff",
  },
})

const ORANGE_DARK = build({
  name: "orange-dark",
  dark: true,
  c: {
    primary: "#f97316",
    secondary: "#fb923c",
    accent: "#fb923c",
    error: "#dc2626",
    warning: "#d97706",
    success: "#16a34a",
    info: "#0ea5e9",
    text: "#e8e6df",
    textMuted: "#a19f8f",
    selectedListItemText: "#0d0d0d",
    background: "#181818",
    backgroundPanel: "#262626",
    backgroundElement: "#303030",
    backgroundMenu: "#3a3a3a",
    border: "#4a4a4a",
    borderActive: "#6b6b6b",
    borderSubtle: "#3a3a3a",
    diffAdded: "#84cc16",
    diffRemoved: "#f97316",
    diffContext: "#a19f8f",
    diffAddedBg: "#1a2e0e",
    diffRemovedBg: "#3a130e",
    diffContextBg: "#181818",
    syntaxComment: "#6b7280",
    syntaxKeyword: "#fb923c",
    syntaxFunction: "#fdba74",
    syntaxString: "#4ade80",
    syntaxNumber: "#f97316",
    syntaxType: "#fb923c",
    syntaxOperator: "#fb923c",
  },
})

const ORANGE_LIGHT = build({
  name: "orange-light",
  dark: false,
  c: {
    primary: "#ea580c",
    secondary: "#c2410c",
    accent: "#ea580c",
    error: "#dc2626",
    warning: "#d97706",
    success: "#0d7b3d",
    info: "#0284c7",
    text: "#37362f",
    textMuted: "#898879",
    selectedListItemText: "#ffffff",
    background: "#ffffff",
    backgroundPanel: "#f7f6f4",
    backgroundElement: "#ecebe9",
    backgroundMenu: "#dbdad8",
    border: "#dbdad8",
    borderActive: "#c1c0b4",
    borderSubtle: "#ecebe9",
    diffAdded: "#84cc16",
    diffRemoved: "#f97316",
    diffContext: "#898879",
    diffAddedBg: "#ecfccb",
    diffRemovedBg: "#ffe4e4",
    diffContextBg: "#ffffff",
    syntaxComment: "#898879",
    syntaxKeyword: "#ea580c",
    syntaxFunction: "#c2410c",
    syntaxString: "#16a34a",
    syntaxNumber: "#c2410c",
    syntaxType: "#ea580c",
    syntaxOperator: "#ea580c",
  },
})

const themes: Theme[] = [
  TRAYAMBAK_DARK,
  ORANGE_DARK,
  NIGHT_SKY,
  OCEAN_DEEP,
  FOREST_CAMP,
  CANDY_POP,
  PAPER_WHITE,
  ORANGE_LIGHT,
  MATRIX_GREEN,
  CRIMSON_DUSK,
  SUNSET_AMBER,
  SAKURA_LIGHT,
  CARBON_STEEL,
  MONO_GRAY,
  VELVET_PURPLE,
  EVERGREEN,
  ARCTIC_FOX,
  // SKT AI LABS Code port — 36 palettes (dark side), see scripts/convert-skt-themes.mjs
  ...SKT_SPECS.map(build),
]

// -- Active theme state -------------------------------------------------------

let active: Theme = TRAYAMBAK_DARK

// Bump on every switch so Ink re-reads the palette: useThemeColors()
// subscribes via useSyncExternalStore, otherwise /theme only took effect
// on some unrelated re-render (or never, while idle).
let version = 0
const listeners = new Set<() => void>()

export function getTheme(): Theme {
  return active
}

export function getThemeVersion(): number {
  return version
}

export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function listThemes(): Theme[] {
  return themes
}

export function setThemeByName(name: string): Theme | undefined {
  const t = themes.find((x) => x.name === name)
  if (t && t !== active) {
    active = t
    version += 1
    for (const fn of listeners) {
      try {
        fn()
      } catch {
        // Never fail the switch on a listener error.
      }
    }
  }
  return t
}

/** Luminance-aware selection foreground (black on bright, white on dark). */
export function selectedForeground(bgColor?: Rgb): Rgb {
  const target = bgColor ?? active.primary
  // Luminance ranges 0–255 (not 0–1): the old `> 0.5` returned white for
  // every non-black background, so near-black surfaces got unreadable
  // black-on-near-black selection text.
  const luminance = 0.299 * target.r + 0.587 * target.g + 0.114 * target.b
  return luminance > 128 ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 }
}

// -- ANSI rendering -----------------------------------------------------------

export function fg(c: Rgb): string {
  return `\x1b[38;2;${c.r};${c.g};${c.b}m`
}

export function bg(c: Rgb): string {
  return `\x1b[48;2;${c.r};${c.g};${c.b}m`
}

/** Apply the active palette to the terminal's default canvas and text. */
export function applyTerminalTheme(): void {
  if (!process.stdout.isTTY) return
  process.stdout.write(`\x1b]11;#${toHex(active.background)}\x07\x1b]10;#${toHex(active.text)}\x07`)
}

function toHex(c: Rgb): string {
  return [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")
}

export const RESET = "\x1b[0m"
export const BOLD = "\x1b[1m"
export const DIM = "\x1b[2m"
export const ITALIC = "\x1b[3m"
export const UNDERLINE = "\x1b[4m"

/** Paint text with a theme token as foreground. */
export function paint(token: keyof Theme, text: string, attrs: string = ""): string {
  const c = active[token] as unknown
  if (!c || typeof c !== "object" || !("r" in (c as object))) return text
  return `${attrs}${fg(c as Rgb)}${text}${RESET}`
}

/** Paint with background + foreground theme tokens. */
export function paintBg(fgToken: keyof Theme, bgToken: keyof Theme, text: string, attrs: string = ""): string {
  const f = active[fgToken] as unknown as Rgb
  const b = active[bgToken] as unknown as Rgb
  if (!f || !b || typeof f !== "object" || !("r" in f)) return text
  return `${attrs}${fg(f)}${bg(b)}${text}${RESET}`
}

/** Strip ANSI sequences (for width math). */
export function stripAnsi(s: string): string {
  return s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
}

/** Visible width of a string (ANSI-aware).
 *  Delegates to npm string-width — the same module Ink wraps Text with —
 *  because the old `stripAnsi(s).length` counted UTF-16 units: Devanagari
 *  matras/virama (separate code points inside the base glyph's cell) blew
 *  the count up, pads came out short and Hindi boxes lost their right
 *  border. One measurement for Ink AND manual boxes = no drift. */
export function visibleLen(s: string): number {
  if (!s) return 0
  return npmStringWidth(s)
}
