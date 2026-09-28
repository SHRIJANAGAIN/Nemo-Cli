/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Subagent picker overlay — SKT AI LABS's subagent dialog ported to Ink: the six
 * builtin types (the trayambak__Agent enum) plus discovered profiles, a
 * numbered list with a selected-row cursor, and no free-text search (so it
 * can't hijack keys from other overlays). Selecting arms the composer: the
 * next prompt becomes that subagent's task (see App's pendingAgentTypeRef).
 *
 *   ↑/↓ or j/k  move · 1-9  jump · enter  select · esc/q  cancel
 */

import React, { useState, type ReactNode } from "react"
import { Box, Text, useStdout } from "ink"
import { mergeAgentOptions } from "./subagent-view.js"
import { isEnter } from "./keys.js"
import { useAppInput } from "./useAppInput.js"
import { useThemeColors } from "./themeColors.js"

export interface AgentPickerProps {
  profiles: Array<{ id: string; name: string; category: string; description: string }>
  onSelect: (value: string) => void
  onExit: () => void
}

export const AgentPicker = ({ profiles, onSelect, onExit }: AgentPickerProps): ReactNode => {
  const theme = useThemeColors()
  const { stdout } = useStdout()
  const options = mergeAgentOptions(profiles)
  const [selected, setSelected] = useState(0)
  const safeIdx = Math.min(selected, Math.max(0, options.length - 1))

  const maxVisible = Math.max(3, Math.min(14, (stdout.rows || 30) - 12))
  const windowStart =
    options.length <= maxVisible
      ? 0
      : Math.max(0, Math.min(safeIdx - Math.floor(maxVisible / 2), options.length - maxVisible))
  const visible = options.slice(windowStart, windowStart + maxVisible)

  useAppInput((input, key) => {
    if (key.escape || input === "q") {
      onExit()
      return
    }
    if (key.upArrow || input === "k") {
      setSelected(Math.max(0, safeIdx - 1))
      return
    }
    if (key.downArrow || input === "j") {
      setSelected(Math.min(options.length - 1, safeIdx + 1))
      return
    }
    if (isEnter(input, key)) {
      const option = options[safeIdx]
      if (option) onSelect(option.value)
      return
    }
    if (input && input >= "1" && input <= "9") {
      const idx = Math.min(options.length - 1, parseInt(input, 10) - 1)
      if (idx >= 0) setSelected(idx)
    }
  })

  return (
    <Box flexDirection="column" height="100%" paddingX={1}>
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color={theme.primary}>
          Launch Subagent
        </Text>
        <Text dimColor>{options.length} agents · type a prompt after selecting</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        {visible.map((option, idx) => {
          const realIdx = windowStart + idx
          const isSelected = realIdx === safeIdx
          return (
            <Box key={option.value}>
              <Text bold={isSelected} color={isSelected ? theme.primary : undefined}>
                {isSelected ? "❯ " : "  "}
                {realIdx + 1}.{" "}
              </Text>
              <Text bold={isSelected} color={option.builtin ? theme.info : theme.success}>
                {option.label}
              </Text>
              <Text color={theme.textMuted}> [{option.category}]</Text>
              <Text dimColor>
                {"  "}
                {option.description}
              </Text>
            </Box>
          )
        })}
      </Box>

      <Box marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
        <Text dimColor>
          {" enter"} select {" · ↑/↓ or j/k"} move {" · 1-9"} jump {" · esc/q"} cancel
        </Text>
      </Box>
    </Box>
  )
}

export default AgentPicker
