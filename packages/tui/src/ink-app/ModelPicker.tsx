/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import React, { type ReactNode, useEffect, useState } from "react"
import { Box, Text, useStdout } from "ink"
import { isEnter } from "./keys.js"
import { useAppInput } from "./useAppInput.js"
import { buildModelPickerRows } from "./model-picker.js"
import { g } from "./glyphs.js"

/** Rows shown at once — windowed like ThemePicker/CommandPalette. */
const MAX_VISIBLE = 12

/** SKT AI LABS shows the model info panel only at this width or wider. */
const WIDE_COLS = 108

export interface ModelPickerProps {
  models: string[]
  /** True while the provider's /v1/models fetch is still in flight. */
  loading?: boolean
  favorites: string[]
  recents: string[]
  current: string
  /** Display name of the backing provider (section header + panel). */
  providerName: string
  /** Host of the provider endpoint (panel only). */
  endpoint: string
  onSelect: (id: string) => void
  onToggleFavorite: (id: string) => void
  onClose: () => void
}

function InfoRow({ label, value }: { label: string; value: string }): ReactNode {
  // SKT AI LABS's panel values are short; trayambak endpoints can be long URLs, and
  // the panel is 30 cols (29 after padding) — trim the tail so label + value
  // always share one line.
  const max = Math.max(4, 28 - label.length)
  const shown = value.length > max ? `${value.slice(0, max - 1)}…` : value
  return (
    <Box justifyContent="space-between">
      <Text dimColor>{label}</Text>
      <Text>{shown}</Text>
    </Box>
  )
}

/** SKT AI LABS's model picker (DialogModel): Favorites → Recent → provider sections,
 * fuzzy filter ranked within sections, ★ favorite toggle (ctrl+f), current
 * marker, and a ≥108-col info panel on the right. */
export function ModelPicker({
  models,
  loading = false,
  favorites,
  recents,
  current,
  providerName,
  endpoint,
  onSelect,
  onToggleFavorite,
  onClose,
}: ModelPickerProps): ReactNode {
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const { stdout } = useStdout()
  const wide = (stdout.columns ?? 0) >= WIDE_COLS

  const rows = buildModelPickerRows({ models, favorites, recents, current, providerName, query })
  const selectedRow = rows[selected]

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
    if (key.ctrl && input === "p") {
      move(-1)
      return
    }
    if (key.ctrl && input === "n") {
      move(1)
      return
    }
    if (key.ctrl && input === "f") {
      // SKT AI LABS's model.favorite_toggle action on the highlighted row.
      const row = rows[selected]
      if (row) onToggleFavorite(row.id)
      return
    }
    if (isEnter(input, key)) {
      const row = rows[selected]
      if (row) onSelect(row.id)
      return
    }
    if (key.escape) {
      onClose()
      return
    }
    if (key.backspace || key.delete) {
      setQuery((q) => Array.from(q).slice(0, -1).join(""))
      return
    }
    if (key.ctrl || key.meta) {
      return // app chords (ctrl+d abort, …) must reach the app handler
    }
    if (input && input.charCodeAt(0) >= 32) {
      setQuery((q) => q + input)
    }
  })

  const list = (
    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
      <Box flexDirection="column" alignItems="center" marginBottom={1}>
        <Text bold color="green">
          Models
        </Text>
        <Text dimColor>{`${providerName} · ${endpoint}`}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color="#6cb6f5">
          {"> "}
          {query}
        </Text>
        <Text dimColor>
          {query
            ? `  ${rows.length} match${rows.length === 1 ? "" : "es"}`
            : `  ${models.length} model${models.length === 1 ? "" : "s"}`}
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
              <Text bold={active}>
                {row.isCurrent ? `${g("dot")} ` : ""}
                {row.id}
                {row.isFavorite ? ` ${g("star")}` : ""}
              </Text>
              {row.isCurrent ? <Text dimColor> (current)</Text> : null}
            </Box>
          )
        })}
        {loading && rows.length === 0 ? (
          <Text dimColor> ⏳ Loading models from provider…</Text>
        ) : rows.length === 0 ? (
          <Text dimColor>{query ? "  no matches" : "  No models reported by this provider."}</Text>
        ) : scrollTop + MAX_VISIBLE < rows.length ? (
          <Text dimColor> ▼ {rows.length - scrollTop - MAX_VISIBLE} more</Text>
        ) : null}
      </Box>
      <Text dimColor>
        {" enter"} use {" ctrl+f"} favorite {" ↑/↓"} move {" type"} filter {" esc"} close
      </Text>
    </Box>
  )

  if (!wide)
    return (
      <Box height="100%" paddingX={1} paddingY={1}>
        {list}
      </Box>
    )

  const status = !selectedRow
    ? "—"
    : selectedRow.isCurrent
      ? `${g("dot")} current`
      : selectedRow.isFavorite
        ? `${g("star")} favorite`
        : recents.includes(selectedRow.id)
          ? "recent"
          : "—"

  return (
    <Box height="100%" paddingX={1} paddingY={1}>
      {list}
      <Box borderLeft borderColor="gray" width={30} paddingLeft={1} flexDirection="column" flexShrink={0}>
        <Text bold>{selectedRow?.id ?? ""}</Text>
        <Text dimColor>{providerName}</Text>
        <InfoRow label="Status" value={status} />
        <InfoRow label="Provider" value={providerName} />
        <InfoRow label="Endpoint" value={endpoint} />
        <InfoRow label="Favorites" value={String(favorites.length)} />
        <InfoRow label="Recents" value={String(recents.length)} />
      </Box>
    </Box>
  )
}

export default ModelPicker
