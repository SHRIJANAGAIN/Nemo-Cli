/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import React, { type ReactNode, useState, useEffect } from "react"
import { Box, Text } from "ink"
import { useThemeColors } from "./themeColors.js"
import { glyphSet, spinnerFrames } from "./glyphs.js"
import { waveLevels } from "../ui/spinner.js"

export const SPINNER_FRAMES: string[] = spinnerFrames()

export const CIRCULAR_FRAMES: string[] =
  glyphSet() === "ascii"
    ? ["o", "*", "-", "+", "x", "#", "=", "%", "@", "O"]
    : ["○", "●", "◕", "◔", "◓", "◒", "◑", "◐", "〇", "◯"]

const SPINNER_INTERVAL_MS = 80

const SPINNER_COLORS = ["cyan", "blue", "magenta", "yellow", "green", "red"]

export interface SpinnerProps {
  color?: string
  children?: ReactNode
  isActive?: boolean
  frames?: string[]
  cycleColors?: boolean
  /** Wave shimmer across string children (default off — existing look unchanged). */
  wave?: boolean
  /** Tick multiplier, >0 (default 1 — existing timing unchanged). */
  speed?: number
}

export const Spinner = ({
  color,
  children,
  isActive = true,
  frames = SPINNER_FRAMES,
  cycleColors = false,
  wave = false,
  speed = 1,
}: SpinnerProps): ReactNode => {
  const theme = useThemeColors()
  const [frame, setFrame] = useState(0)
  const [colorIdx, setColorIdx] = useState(0)
  const spinnerColor = cycleColors ? SPINNER_COLORS[colorIdx] : (color ?? theme.textMuted)
  const intervalMs = speed > 0 ? SPINNER_INTERVAL_MS / speed : SPINNER_INTERVAL_MS

  useEffect(() => {
    if (!isActive) return
    const interval = setInterval(() => {
      setFrame((f) => (f + 1) % frames.length)
      if (cycleColors) {
        setColorIdx((c) => (c + 1) % SPINNER_COLORS.length)
      }
    }, intervalMs)
    return () => clearInterval(interval)
    // frames.length (not the array): callers passing an inline literal got
    // a new identity every render, restarting the 80ms interval and
    // stuttering the spinner back to frame 0.
  }, [isActive, frames.length, cycleColors, intervalMs])

  const renderChildren = (): ReactNode => {
    if (!children) return null
    if (wave && typeof children === "string") {
      const chars = [...children]
      const levels = waveLevels(chars.length, frame)
      return (
        <Text color={spinnerColor} bold>
          {chars.map((ch, i) => (
            <Text key={i} dimColor={levels[i] === 0} bold={levels[i] === 2} color={spinnerColor}>
              {ch}
            </Text>
          ))}
        </Text>
      )
    }
    return (
      <Text color={spinnerColor} bold>
        {children}
      </Text>
    )
  }

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
      {renderChildren()}
    </Box>
  )
}

export default Spinner
