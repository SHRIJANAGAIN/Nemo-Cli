/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */
import React, { type ReactNode, useState, useEffect } from "react"
import { Box, Text, useStdout } from "ink"
import { TrayambakLogo } from "./TrayambakLogo.js"
import { isEnter } from "./keys.js"
import { useAppInput } from "./useAppInput.js"
import { g } from "./glyphs.js"

export interface ThemeOption {
  name: string
  label: string
  description?: string
  swatch: string // sample colored text so the user sees the accent colour
}

export interface ThemePickerProps {
  themes: ThemeOption[]
  defaultTheme?: string
  onSelect: (name: string) => void
  onExit?: () => void
}

const CODE_PREVIEW = [
  "function greet(name: string) {",
  '  return "Hello, " + name;',
  "  return `Hello, ${name}!`;",
  "}",
].join("\n")

function CodePreview({ accent }: { accent: string }): ReactNode {
  const lines = CODE_PREVIEW.split("\n")
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text color={accent} bold>
        {lines[0]}
      </Text>
      <Text color={accent}>{lines[1]}</Text>
      <Text dimColor>{lines[2]}</Text>
      <Text color={accent}>{lines[3]}</Text>
    </Box>
  )
}

/**
 * Startup theme chooser. Shown only once, on first run.
 */
/** Hard cap on list rows (53 themes: 17 bundled + 36 from the SKT AI LABS
 *  Code port). The LIVE count comes from fitLayout(). */
const MAX_VISIBLE = 12

/** In-frame row budget: the picker renders inside App's fixed-height
 *  bordered root (border 2) plus its own paddingY (2), so only rows-4
 *  lines exist to paint. Ink's Box defaults to flexShrink:1, so content
 *  that doesn't fit gets SQUEEZED while its Text still paints at natural
 *  height - stacking rows on top of each other: the header landed inside
 *  the logo, "▼ 41 more" painted over "Orange Light", and the accent line
 *  overwrote the preview's bottom border. Fit everything up front (logo
 *  first, the preview is the luxury item), and the children below also
 *  carry flexShrink={0} so a budget shortfall can never overlap again. */
function fitLayout(rows: number): { logoCompact: boolean; showPreview: boolean; visible: number } {
  const avail = Math.max(4, rows - 4)
  // per-child cost, margins included: logo+1, header+margin 3, list (worst
  // case both ▲/▼ marker rows) + margin 3, help 1, preview (border 2 +
  // code pad 2 + 4 code lines + accent line) + margin 10.
  const room = (logoRows: number, preview: boolean): number => avail - (logoRows + 1) - 3 - 3 - 1 - (preview ? 10 : 0)
  const pick = (logoRows: number, showPreview: boolean, min: number) => {
    const free = room(logoRows, showPreview)
    if (free < min) return undefined
    return { logoCompact: logoRows === 1, showPreview, visible: Math.min(MAX_VISIBLE, free) }
  }
  // Priority: full logo > a usable list > the preview box. The preview
  // only earns its 10 rows when >= 6 themes remain visible beside it.
  return (
    pick(10, /*showPreview*/ true, 6) ??
    pick(10, /*showPreview*/ false, 1) ??
    pick(1, /*showPreview*/ true, 6) ??
    pick(1, /*showPreview*/ false, 1) ?? { logoCompact: true, showPreview: false, visible: 1 }
  )
}

function initialIndex(themes: ThemeOption[], defaultTheme?: string): number {
  const idx = themes.findIndex((t) => t.name === defaultTheme)
  if (idx >= 0) return idx
  const firstDark = themes.findIndex((t) => !t.name.endsWith("-light"))
  return firstDark >= 0 ? firstDark : 0
}

export function ThemePicker({ themes, defaultTheme, onSelect, onExit }: ThemePickerProps): ReactNode {
  const [selected, setSelected] = useState(() => initialIndex(themes, defaultTheme))
  const [scrollTop, setScrollTop] = useState(0)
  const { stdout } = useStdout()
  const { logoCompact, showPreview, visible } = fitLayout(stdout.rows || 36)

  // Keep the selected row inside the visible window (also positions the
  // window for the initial default theme on mount; re-clamps when a resize
  // shrinks the window).
  useEffect(() => {
    setScrollTop((st) => (selected < st ? selected : selected >= st + visible ? selected - visible + 1 : st))
  }, [selected, visible])

  useAppInput((input, key) => {
    if (key.upArrow) {
      setSelected((prev) => (prev - 1 + themes.length) % themes.length)
      return
    }
    if (key.downArrow) {
      setSelected((prev) => (prev + 1) % themes.length)
      return
    }
    if (isEnter(input, key)) {
      const theme = themes[selected]
      if (theme) onSelect(theme.name)
      return
    }
    if (key.tab) {
      setSelected((prev) => (prev + 1) % themes.length)
      return
    }
    if (key.escape && onExit) {
      onExit()
      return
    }
  })

  const current = themes[selected]

  return (
    <Box flexDirection="column" height="100%" paddingX={1} paddingY={1}>
      <Box flexDirection="column" alignItems="center" marginBottom={1} flexShrink={0}>
        <TrayambakLogo compact={logoCompact} />
      </Box>
      <Box flexDirection="column" alignItems="center" marginBottom={1} flexShrink={0}>
        <Text bold color="green">
          Trayambak — Choose a Theme
        </Text>
        <Text dimColor>Pick the text style that looks best with your terminal (one-time setup)</Text>
      </Box>
      <Box flexDirection="column" marginBottom={1} flexShrink={0}>
        {scrollTop > 0 ? (
          <Text dimColor>
            {" "}
            {g("caretUp")} {scrollTop} more
          </Text>
        ) : null}
        {themes.slice(scrollTop, scrollTop + visible).map((theme, i) => {
          const idx = scrollTop + i
          return (
            <Box key={theme.name}>
              <Text color={idx === selected ? "#6cb6f5" : undefined} bold={idx === selected}>
                {idx === selected ? `${g("picker")} ` : "  "}
              </Text>
              <Text color={theme.swatch} bold={idx === selected}>
                {theme.label}
              </Text>
              {theme.description ? <Text dimColor> {theme.description}</Text> : null}
            </Box>
          )
        })}
        {scrollTop + visible < themes.length ? (
          <Text dimColor>
            {" "}
            {g("caretDown")} {themes.length - scrollTop - visible} more
          </Text>
        ) : null}
      </Box>
      {current && showPreview ? (
        <Box flexDirection="column" borderStyle="round" borderColor={current.swatch} marginBottom={1} flexShrink={0}>
          <CodePreview accent={current.swatch} />
          <Text dimColor> Accent colour: {current.swatch}</Text>
        </Box>
      ) : null}
      <Box flexShrink={0}>
        <Text dimColor>
          {" enter"} select {" ↑/↓"} browse {" esc"} keep default
        </Text>
      </Box>
    </Box>
  )
}
export default ThemePicker
