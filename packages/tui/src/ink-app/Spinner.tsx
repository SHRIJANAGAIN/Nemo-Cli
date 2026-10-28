/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { type ReactNode } from "react"
import { Box, Text } from "ink"
import { useThemeColors } from "./themeColors.js"
import { glyphSet, spinnerFrames } from "./glyphs.js"
import { waveLevels } from "../ui/spinner.js"
import { cycleIndex } from "./animations.js"
import { useAnimationClock } from "./use-animation-clock.js"
import { graphemes } from "./utils/stringWidth.js"

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
  // One shared clock, this widget's cadence: an inline `frames` literal used to
  // restart the 80ms interval every render (a new array identity), stuttering
  // the spinner back to frame 0. A derived tick has no interval to restart.
  const tick = useAnimationClock(speed > 0 ? SPINNER_INTERVAL_MS / speed : SPINNER_INTERVAL_MS, isActive)
  const frame = cycleIndex(tick, frames.length)
  const colorIdx = cycleIndex(tick, SPINNER_COLORS.length)
  const spinnerColor = cycleColors ? SPINNER_COLORS[colorIdx] : (color ?? theme.textMuted)

  const renderChildren = (): ReactNode => {
    if (!children) return null
    if (wave && typeof children === "string") {
      // graphemes(), not [...string]: a combining mark or emojiZWJ sequence
      // spread into code points gets coloured per fragment and reassembles into
      // something the terminal never asked for.
      const chars = graphemes(children)
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
