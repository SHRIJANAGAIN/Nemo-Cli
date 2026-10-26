/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Which-key overlay — Shrijan's leader-key help ported to Ink. Opened with the
 * leader chord (Ctrl+K): lists every leader action plus the always-on global
 * hotkeys. Pressing an action's key runs it (and closes the window); esc/q
 * just closes. The action table lives in App (leaderActions) so the overlay
 * stays a dumb renderer.
 *
 *   any mapped key  run action · esc/q  close
 */

import React, { type ReactNode } from "react"
import { Box, Text } from "ink"
import { useThemeColors } from "./themeColors.js"
import { isEnter } from "./keys.js"
import { useAppInput } from "./useAppInput.js"
import { GLOBAL_SHORTCUTS } from "../keybindings.js"

export interface WhichKeyAction {
  key: string
  label: string
  run: () => void
}

export interface WhichKeyProps {
  actions: WhichKeyAction[]
  onClose: () => void
}

// Global chords come from the shared table (keybindings.ts) so this window
// and /keymap can never drift apart again; esc is overlay-contextual, not a
// global chord, so it is appended here.
const GLOBAL_HOTKEYS: Array<[string, string]> = [
  ...GLOBAL_SHORTCUTS.map((s): [string, string] => [s.keys, s.label]),
  ["esc", "close overlay / clear input"],
]

export const WhichKey = ({ actions, onClose }: WhichKeyProps): ReactNode => {
  const theme = useThemeColors()

  useAppInput((input, key) => {
    if (key.escape || input === "q") {
      onClose()
      return
    }
    if (key.ctrl || isEnter(input, key) || key.tab) return
    const hit = actions.find((a) => a.key === input)
    if (hit) {
      onClose()
      hit.run()
    }
  })

  return (
    <Box flexDirection="column" height="100%" paddingX={1}>
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold color={theme.primary}>
          Keyboard
        </Text>
        <Text dimColor>leader: ctrl+k — press a key to run · esc/q to close</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={theme.info}>
          After ctrl+k
        </Text>
        {actions.map((a) => (
          <Box key={a.key}>
            <Box width={9}>
              <Text bold color={theme.secondary}>
                {a.key}
              </Text>
            </Box>
            <Text>{a.label}</Text>
          </Box>
        ))}
      </Box>

      <Box flexDirection="column">
        <Text bold color={theme.info}>
          Global
        </Text>
        {GLOBAL_HOTKEYS.map(([k, label]) => (
          <Box key={k}>
            <Box width={9}>
              <Text bold color={theme.primary}>
                {k}
              </Text>
            </Box>
            <Text dimColor>{label}</Text>
          </Box>
        ))}
      </Box>

      <Box marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
        <Text dimColor>esc/q close · full list also at /keymap</Text>
      </Box>
    </Box>
  )
}

export default WhichKey
