/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { type ReactNode, useState, useEffect } from "react"
import { Box, Text } from "ink"
import { useThemeColors } from "./themeColors.js"

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export const CIRCULAR_FRAMES = ["○", "●", "◕", "◔", "◓", "◒", "◑", "◐", "〇", "◯"]

const SPINNER_INTERVAL_MS = 80

const SPINNER_COLORS = ["cyan", "blue", "magenta", "yellow", "green", "red"]

export interface SpinnerProps {
  color?: string
  children?: ReactNode
  isActive?: boolean
  frames?: string[]
  cycleColors?: boolean
}

export const Spinner = ({
  color,
  children,
  isActive = true,
  frames = SPINNER_FRAMES,
  cycleColors = false,
}: SpinnerProps): ReactNode => {
  const theme = useThemeColors()
  const [frame, setFrame] = useState(0)
  const [colorIdx, setColorIdx] = useState(0)
  const spinnerColor = cycleColors ? SPINNER_COLORS[colorIdx] : (color ?? theme.textMuted)

  useEffect(() => {
    if (!isActive) return
    const interval = setInterval(() => {
      setFrame((f) => (f + 1) % frames.length)
      if (cycleColors) {
        setColorIdx((c) => (c + 1) % SPINNER_COLORS.length)
      }
    }, SPINNER_INTERVAL_MS)
    return () => clearInterval(interval)
    // frames.length (not the array): callers passing an inline literal got
    // a new identity every render, restarting the 80ms interval and
    // stuttering the spinner back to frame 0.
  }, [isActive, frames.length, cycleColors])

  if (!isActive) {
    return (
      <Box flexDirection="row" gap={1} flexShrink={0}>
        <Text color={spinnerColor}>⋯</Text>
        {children && <Text color={spinnerColor}>{children}</Text>}
      </Box>
    )
  }

  return (
    <Box flexDirection="row" gap={1} flexShrink={0}>
      {/* bold: the waiting glyph must carry the line ("animation bada /
          bolder") — a hairline braille cell read as noise at 80ms. */}
      <Text color={spinnerColor} bold>
        {frames[frame]}
      </Text>
      {children && (
        <Text color={spinnerColor} bold>
          {children}
        </Text>
      )}
    </Box>
  )
}

export default Spinner
