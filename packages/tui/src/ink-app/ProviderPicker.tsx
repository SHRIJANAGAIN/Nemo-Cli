/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */
import React, { type ReactNode, useState } from "react"
import { Box, Text, useStdout } from "ink"
import { TrayambakLogo, logoLineCount } from "./TrayambakLogo.js"
import { isEnter } from "./keys.js"
import { useAppInput } from "./useAppInput.js"
import { g } from "./glyphs.js"
import { stringWidth, sliceByWidth } from "./utils/stringWidth.js"

export interface ProviderPickRow {
  id: string
  label: string
  endpoint: string
  hasKey: boolean
  needsBaseUrl: boolean
  active: boolean
}

export interface ProviderPickerProps {
  providers: ProviderPickRow[]
  currentId: string
  onSelect: (id: string) => void
  onExit?: () => void
}

function initialIndex(providers: ProviderPickRow[], currentId: string): number {
  const idx = providers.findIndex((p) => p.id === currentId)
  return idx >= 0 ? idx : 0
}

export interface FittedProviderRow {
  marker: string
  num: string
  label: string
  flags: string
  endpoint: string
}

/**
 * Fit one provider row into `inner` columns: fixed marker/number/flags,
 * flexible label, flexible endpoint. Both flex fields cut with "…" and the
 * total never exceeds `inner`, so rows can neither wrap nor hide siblings.
 */
export function fitProviderRow(
  row: ProviderPickRow,
  index: number,
  selected: boolean,
  inner: number,
): FittedProviderRow {
  const marker = selected ? `${g("picker")} ` : "  "
  const num = `${index + 1}. `.padEnd(4)
  const flags = `${row.active ? ` ${g("dot")} active` : ""}${row.hasKey ? ` key ${g("ok")}` : ""}`
  const endpointFull = `${row.endpoint}${row.needsBaseUrl ? " · needs Base URL" : ""}`
  const labelBudget = Math.max(8, inner - stringWidth(`${marker}${num}`) - stringWidth(`${flags}  ${endpointFull}`) - 1)
  const clippedLabel = sliceByWidth(row.label, labelBudget)
  const label =
    clippedLabel.length < row.label.length ? `${sliceByWidth(row.label, Math.max(1, labelBudget - 1))}…` : clippedLabel
  const endpointBudget = Math.max(
    12,
    inner - stringWidth(`${marker}${num}${label}${flags}  `) - stringWidth(" · needs Base URL") - 1,
  )
  const clippedEndpoint = sliceByWidth(endpointFull, endpointBudget)
  const endpoint =
    clippedEndpoint.length < endpointFull.length
      ? `${sliceByWidth(endpointFull, Math.max(1, endpointBudget - 1))}…`
      : clippedEndpoint
  return { marker, num, label, flags, endpoint }
}

/** Rows outside the list that the frame always consumes: App border (2) +
 *  paddingY (2) + title block with margin (3) + footer (1) + list margin
 *  (1) + 2 rows of slack = 11. */
const RESERVED = 11

export interface PickerFit {
  showLogo: boolean
  winStart: number
  winSize: number
}

/**
 * Height budget for the picker. When content met the box height EXACTLY,
 * yoga dropped individual TEXT lines (not whole rows): at 40 terminal rows
 * the title line and one list row rendered blank while the frame stayed
 * exactly `rows` lines tall — so "fits" must mean strictly-under with the
 * RESERVED slack. The banner shows only when the remainder can hold the
 * head rows of the list, and the list windows around the selection so any
 * provider count fits; row numbers stay original catalog indices.
 */
export function providerPickerFit(opts: {
  rows: number
  providerCount: number
  selected: number
  logoLines: number
}): PickerFit {
  const { rows, providerCount, selected, logoLines } = opts
  const budget = Math.max(6, rows - RESERVED)
  const logoH = logoLines > 0 ? logoLines + 1 : 0 // banner lines + margin
  const showLogo = logoH > 0 && budget - logoH >= Math.min(providerCount, 5)
  const listBudget = Math.max(3, budget - (showLogo ? logoH : 0))
  const winSize = Math.max(1, Math.min(providerCount, listBudget))
  const winStart = Math.max(0, Math.min(selected - Math.floor((winSize - 1) / 2), providerCount - winSize))
  return { showLogo, winStart, winSize }
}

/**
 * Backend chooser for /login + /provider add (arrow menu like the theme
 * picker — no typed number/id needed, though the composer fallback stays).
 */
export function ProviderPicker({ providers, currentId, onSelect, onExit }: ProviderPickerProps): ReactNode {
  const [selected, setSelected] = useState(() => initialIndex(providers, currentId))

  useAppInput((input, key) => {
    if (key.upArrow) {
      setSelected((prev) => (prev - 1 + providers.length) % providers.length)
      return
    }
    if (key.downArrow) {
      setSelected((prev) => (prev + 1) % providers.length)
      return
    }
    if (key.tab) {
      setSelected((prev) => (prev + 1) % providers.length)
      return
    }
    if (isEnter(input, key)) {
      const row = providers[selected]
      if (row) onSelect(row.id)
      return
    }
    // Number shortcuts 1-9 (kept from the typed flow).
    const n = parseInt(input, 10)
    if (Number.isFinite(n) && n >= 1 && n <= providers.length) {
      const row = providers[n - 1]
      if (row) onSelect(row.id)
      return
    }
    if (key.escape && onExit) {
      onExit()
    }
  })

  const { stdout } = useStdout()
  const termWidth = stdout?.columns ?? 100
  // Usable inner width: App root border (2) + this box paddingX (2) + margin.
  const inner = Math.max(20, termWidth - 6)
  const rows = stdout?.rows ?? 24
  const { showLogo, winStart, winSize } = providerPickerFit({
    rows,
    providerCount: providers.length,
    selected,
    logoLines: logoLineCount(),
  })
  const visible = providers.slice(winStart, winStart + winSize)
  const above = winStart
  const below = providers.length - winStart - winSize

  return (
    <Box flexDirection="column" height="100%" paddingX={1} paddingY={1}>
      {showLogo ? (
        <Box flexDirection="column" alignItems="center" marginBottom={1}>
          <TrayambakLogo />
        </Box>
      ) : null}
      <Box flexDirection="column" alignItems="center" marginBottom={1}>
        <Text bold color="green">
          Trayambak — Connect a Provider
        </Text>
        <Text dimColor>Choose a backend, then enter its API key</Text>
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        {above > 0 ? <Text dimColor>{`  ↑ ${above} more above`}</Text> : null}
        {visible.map((row, i) => {
          const idx = winStart + i
          // ONE truncating text node per row on exact columns (see
          // fitProviderRow): sibling Texts used to wrap mid-row past the
          // frame (long endpoint URLs), and wrapped tails collided with
          // neighbours while the frame ate whole rows ("providers hidden").
          const fitted = fitProviderRow(row, idx, idx === selected, inner)
          const selectedColor = idx === selected ? "#6cb6f5" : undefined
          return (
            <Box key={row.id}>
              <Text wrap="truncate-end">
                <Text color={selectedColor} bold={idx === selected}>
                  {fitted.marker}
                </Text>
                <Text dimColor>{fitted.num}</Text>
                <Text color={selectedColor} bold={idx === selected}>
                  {fitted.label}
                </Text>
                {row.active ? <Text color="green">{` ${g("dot")} active`}</Text> : null}
                {row.hasKey ? <Text color="green">{` key ${g("ok")}`}</Text> : null}
                <Text dimColor>{`  ${fitted.endpoint}`}</Text>
              </Text>
            </Box>
          )
        })}
        {below > 0 ? <Text dimColor>{`  ↓ ${below} more below`}</Text> : null}
      </Box>
      <Text dimColor>
        {" enter"} select {" ↑/↓"} browse {" 1-9"} jump {" esc"} type instead
      </Text>
    </Box>
  )
}
export default ProviderPicker
