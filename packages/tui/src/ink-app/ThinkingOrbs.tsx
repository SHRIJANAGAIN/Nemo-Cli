/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import React, { type ReactNode, useEffect, useState } from "react"
import { Box, Text } from "ink"
import { GRID_COLS, GRID_ROWS, gridPaint, RIBBON_TICK_MS, shimmerPaint, silverShade } from "./thinking-ribbon.js"

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
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (paused) return
    const timer = setInterval(() => setFrame((f) => f + 1), RIBBON_TICK_MS)
    return () => clearInterval(timer)
  }, [paused])

  // One snapshot per render: grid, band and label all read the same tick.
  // ASCII dots always ('o'): voted best-looking — the braille bullets render
  // inconsistently across fonts, plain 'o' never does.
  const grid = gridPaint(frame, /*ascii*/ true)
  const chars = shimmerPaint(label, frame)

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
