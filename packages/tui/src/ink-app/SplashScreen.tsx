/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import React, { type ReactNode, useEffect, useState } from "react"
import { Box, Text } from "ink"
import { useAppInput } from "./useAppInput.js"
import { isEnter } from "./keys.js"
import { TrayambakLogo } from "./TrayambakLogo.js"

export interface SplashScreenProps {
  /** Advance past the splash (timer expiry or keypress both call this). */
  onDone: () => void
  /** Milliseconds before auto-advance. No timer is ever displayed. */
  durationMs?: number
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/**
 * First-run welcome splash (codex-style Welcome step): the SAME ASCII logo
 * the chat's WelcomeScreen shows (logo_ansi.txt via TrayambakLogo — the old
 * pixel "feather" mark was removed on request: the logo must be the one
 * from the chat), then "Welcome to Trayambak CLI!" and the warm-up spinner.
 * Any key skips; the timer auto-advances. The duration is never displayed.
 */
export function SplashScreen({ onDone, durationMs = 10_000 }: SplashScreenProps): ReactNode {
  const [frame, setFrame] = useState(0)
  const doneRef = React.useRef(onDone)
  doneRef.current = onDone

  useEffect(() => {
    const timer = setTimeout(() => doneRef.current(), durationMs)
    const spin = setInterval(() => setFrame((f) => f + 1), 120)
    return () => {
      clearTimeout(timer)
      clearInterval(spin)
    }
  }, [durationMs])

  useAppInput((input, key) => {
    if (isEnter(input, key) || key.escape || key.return || (input && input.length > 0)) {
      doneRef.current()
    }
  })

  return (
    <Box flexDirection="column" height="100%" alignItems="center" justifyContent="center">
      <Box flexDirection="column" alignItems="center" marginBottom={1}>
        <TrayambakLogo compact={false} />
      </Box>
      <Text bold color="#6cb6f5">
        Welcome to Trayambak CLI!
      </Text>
      <Text dimColor>by SKT AI LABS PRIVATE LIMITED</Text>
      <Box marginTop={1}>
        {/* bold: the warm-up glyph must carry the wait ("animation bada /
            bolder") — a hairline braille cell at 120ms read as noise. */}
        <Text bold color="#6cb6f5">
          {SPINNER[frame % SPINNER.length]}
        </Text>
        <Text dimColor> Setting things up…</Text>
      </Box>
    </Box>
  )
}
export default SplashScreen
