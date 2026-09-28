/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import React, { type ReactNode, useState } from "react"
import { Box, Text } from "ink"
import { TrayambakLogo } from "./TrayambakLogo.js"
import { isEnter } from "./keys.js"
import { useAppInput } from "./useAppInput.js"
import { g } from "./glyphs.js"

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

  return (
    <Box flexDirection="column" height="100%" paddingX={1} paddingY={1}>
      <Box flexDirection="column" alignItems="center" marginBottom={1}>
        <TrayambakLogo />
      </Box>
      <Box flexDirection="column" alignItems="center" marginBottom={1}>
        <Text bold color="green">
          Trayambak — Connect a Provider
        </Text>
        <Text dimColor>Choose a backend, then enter its API key</Text>
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        {providers.map((row, idx) => (
          <Box key={row.id}>
            <Text color={idx === selected ? "#6cb6f5" : undefined} bold={idx === selected}>
              {idx === selected ? `${g("picker")} ` : "  "}
            </Text>
            <Text dimColor>{`${idx + 1}. `}</Text>
            <Text color={idx === selected ? "#6cb6f5" : undefined} bold={idx === selected}>
              {row.label}
            </Text>
            {row.active ? <Text color="green"> {g("dot")} active</Text> : null}
            {row.hasKey ? <Text color="green"> key {g("ok")}</Text> : null}
            <Text dimColor>{`  ${row.endpoint}${row.needsBaseUrl ? " · needs Base URL" : ""}`}</Text>
          </Box>
        ))}
      </Box>
      <Text dimColor>
        {" enter"} select {" ↑/↓"} browse {" 1-9"} jump {" esc"} type instead
      </Text>
    </Box>
  )
}
export default ProviderPicker
