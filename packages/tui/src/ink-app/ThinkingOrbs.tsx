/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { type ReactNode } from "react"
import { Box, Text } from "ink"
import {
  GRID_COLS,
  GRID_ROWS,
  gridPaint,
  gridSettled,
  RIBBON_TICK_MS,
  shimmerPaint,
  shimmerSettled,
  silverShade,
} from "./thinking-ribbon.js"
import { motionTravels } from "./animations.js"
import { useAnimationClock, useMotionLevel } from "./use-animation-clock.js"

export interface ThinkingOrbsProps {
  /** Status word the shimmer sweeps across. Defaults to the thinking word. */
  label?: string
  /** Dim suffix after the label (elapsed seconds). */
  suffix?: string
  /** Freeze the animation (tests / non-TTY capture). */
  paused?: boolean
}

/**
 * Thinking indicator: a 3×3 grid of blue dots (brightness travelling
 * diagonally) beside the Codex-style shimmer word. No bullet (removed on
 * request); the word itself is untouched.
 */
export function ThinkingOrbs({ label = "Thinking…", suffix = "", paused = false }: ThinkingOrbsProps): ReactNode {
  const level = useMotionLevel()
  // Shared clock instead of a private interval: the ribbon, the spinner and the
  // tool-box borders all read the same tick, so a thinking screen repaints once
  // per frame instead of once per animated component.
  const frame = useAnimationClock(RIBBON_TICK_MS, !paused)

  // Both halves of this indicator MOVE — the eyes travel round the square and
  // the band sweeps along the word — so below `full` they show the designed
  // still instead of a sampled frame. Sampling is not neutral here: frame 0 of
  // the shimmer leaves every char outside the band, i.e. the status word DIMMED,
  // and frame 0 of the grid lights one corner and blanks the rest. Asking for
  // less motion must not cost the user the thing the indicator says.
  const travels = motionTravels(level)
  const grid = travels ? gridPaint(frame, /*ascii*/ true) : gridSettled()
  const chars = travels ? shimmerPaint(label, frame) : shimmerSettled(label)

  return (
    <Box flexDirection="row" gap={1} flexShrink={0} alignItems="center">
      <Box flexDirection="column" flexShrink={0}>
        {grid.map((cells, y) => (
          <Box key={y} flexDirection="row" flexShrink={0}>
            {cells.map((cell, x) => (
              <Text key={x} color={cell.color} bold>
                {cell.glyph}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
      <Text>
        {chars.map((c, i) => (
          <Text key={i} color={c.color} bold={c.bold} dimColor={c.dim}>
            {c.ch}
          </Text>
        ))}
        {suffix ? <Text color={silverShade(1)}>{suffix}</Text> : null}
      </Text>
    </Box>
  )
}

/** Thinking-mark footprint, for tests. */
export function sphereFootprint(_ascii: boolean): { cols: number; rows: number } {
  return { cols: GRID_COLS, rows: GRID_ROWS }
}

export default ThinkingOrbs
