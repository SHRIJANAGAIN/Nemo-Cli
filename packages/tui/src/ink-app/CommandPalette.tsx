/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { type ReactNode, useEffect, useState } from "react"
import { Box, Text } from "ink"
import { isEnter } from "./keys.js"
import { useAppInput } from "./useAppInput.js"
import { buildPaletteRows, type PaletteEntry } from "./command-palette.js"
import { g } from "./glyphs.js"

/** Rows shown at once — windowed like ThemePicker so long command lists
 * stay inside a small viewport (▲/▼ indicators mark the hidden rows). */
const MAX_VISIBLE = 12

export interface CommandPaletteProps {
  entries: PaletteEntry[]
  onSelect: (entry: PaletteEntry) => void
  onClose: () => void
}

/** SKT AI LABS-style command palette (ctrl+p): fuzzy filter over every action and
 * slash command, Suggested pinned while unfiltered, ranked while typing. */
export function CommandPalette({ entries, onSelect, onClose }: CommandPaletteProps): ReactNode {
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)

  const rows = buildPaletteRows(entries, query)

  // A new query starts the selection back at the top row.
  useEffect(() => {
    setSelected(0)
  }, [query])

  // Keep the selected row inside the visible window.
  useEffect(() => {
    setScrollTop((st) => (selected < st ? selected : selected >= st + MAX_VISIBLE ? selected - MAX_VISIBLE + 1 : st))
  }, [selected])

  useAppInput((input, key) => {
    const move = (delta: number): void => {
      const n = rows.length
      if (n === 0) return
      setSelected((prev) => (prev + delta + n) % n)
    }
    if (key.upArrow) {
      move(-1)
      return
    }
    if (key.downArrow) {
      move(1)
      return
    }
    // SKT AI LABS reuses ctrl+p / ctrl+n as dialog prev/next while its dialogs are
    // open; the app-level ctrl+p chord is overlay-guarded, so this is safe.
    if (key.ctrl && input === "p") {
      move(-1)
      return
    }
    if (key.ctrl && input === "n") {
      move(1)
      return
    }
    if (isEnter(input, key)) {
      const row = rows[selected]
      if (row) onSelect(row.entry)
      return
    }
    if (key.escape) {
      onClose()
      return
    }
    if (key.backspace || key.delete) {
      // Drop one full code point (not one UTF-16 unit) so multi-byte
      // characters never leave half a grapheme behind.
      setQuery((q) => Array.from(q).slice(0, -1).join(""))
      return
    }
    if (key.ctrl || key.meta) {
      return // app chords (ctrl+d abort, …) must reach the app handler
    }
    if (input && input.charCodeAt(0) >= 32) {
      // Plain text (or a whole pasted chunk) filters the list.
      setQuery((q) => q + input)
    }
  })

  return (
    <Box flexDirection="column" height="100%" paddingX={1} paddingY={1}>
      <Box flexDirection="column" alignItems="center" marginBottom={1}>
        <Text bold color="green">
          Commands
        </Text>
        <Text dimColor>Run any action or slash command</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color="#6cb6f5">
          {"> "}
          {query}
        </Text>
        <Text dimColor>
          {query ? `  ${rows.length} match${rows.length === 1 ? "" : "es"}` : `  ${entries.length} commands & actions`}
        </Text>
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        {scrollTop > 0 ? <Text dimColor> ▲ {scrollTop} more</Text> : null}
        {rows.slice(scrollTop, scrollTop + MAX_VISIBLE).map((row, i) => {
          const idx = scrollTop + i
          const active = idx === selected
          return (
            <Box key={row.rowId}>
              <Text color={active ? "#6cb6f5" : undefined} bold={active}>
                {active ? `${g("picker")} ` : "  "}
              </Text>
              <Text dimColor>{`[${row.category}] `}</Text>
              <Text bold={active}>{row.entry.title}</Text>
              {row.entry.keybinding ? <Text dimColor>{`  ${row.entry.keybinding}`}</Text> : null}
              {row.entry.description ? <Text dimColor>{`  ${row.entry.description}`}</Text> : null}
            </Box>
          )
        })}
        {rows.length === 0 ? (
          <Text dimColor> no matches</Text>
        ) : scrollTop + MAX_VISIBLE < rows.length ? (
          <Text dimColor> ▼ {rows.length - scrollTop - MAX_VISIBLE} more</Text>
        ) : null}
      </Box>
      <Text dimColor>
        {" enter"} run {" ↑/↓"} move {" type"} filter {" esc"} close
      </Text>
    </Box>
  )
}

export default CommandPalette
