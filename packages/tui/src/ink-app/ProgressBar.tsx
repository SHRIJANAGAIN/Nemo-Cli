/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { type ReactNode } from "react"
import { Box, Text } from "ink"
import { indeterminateCells, progressCells, type BarCell, type BarStyle } from "./animations.js"
import { useAnimationClock } from "./use-animation-clock.js"
import { useThemeColors } from "./themeColors.js"
import { glyphSet } from "./glyphs.js"

export interface ProgressBarProps {
  /** 0..1 — out-of-range or non-finite values clamp instead of throwing.
   *  Ignored when `indeterminate` is set. */
  value?: number
  /** Track length in cells. The render is always exactly this wide. */
  width: number
  style?: BarStyle
  /** Fill colour (defaults to the theme accent). */
  color?: string
  /** Empty-track colour (defaults to the theme border). */
  trackColor?: string
  /** Sweep a window across the track instead of showing `value`, for work with
   *  no measurable denominator. */
  indeterminate?: boolean
  /** Sweep cadence in ms (default 120 — 8 cells a second reads as travel
   *  without turning into a strobe on a 120fps clock). */
  intervalMs?: number
  /** Round-trip window in cells (default: a quarter of the track, min 2). */
  windowCells?: number
}

/** How many cells a sweeping window covers on a bar of `width`. */
function defaultWindow(width: number): number {
  return Math.max(2, Math.min(Math.ceil(width / 4), Math.max(1, width)))
}

/**
 * A determinate (or sweeping) bar, coloured in two runs.
 *
 * The two-run split is the reason this component exists next to the pure
 * `progressCells()` helper: a single `<Text>` would paint the empty track in the
 * accent too, and a "50% full" bar would be indistinguishable from a 100% one at
 * a glance. Zone colours come from the cell model, so sub-cell fractional
 * glyphs keep their own colour instead of being flattened to a rounding.
 */
export function ProgressBar({
  value = 0,
  width,
  style = "block",
  color,
  trackColor,
  indeterminate = false,
  intervalMs = 120,
  windowCells,
}: ProgressBarProps): ReactNode {
  const theme = useThemeColors()
  const ascii = glyphSet() === "ascii"
  const fill = color ?? theme.accent
  const track = trackColor ?? theme.border
  const tick = useAnimationClock(intervalMs, indeterminate)

  const cells: BarCell[] = indeterminate
    ? indeterminateCells(width, tick, windowCells ?? defaultWindow(width), style, ascii)
    : progressCells(value, width, style, { ascii })

  const runs: { key: string; text: string; tone: string; dim: boolean }[] = []
  for (const cell of cells) {
    const tone = cell.zone === "empty" ? track : fill
    const dim = cell.zone === "partial"
    const last = runs[runs.length - 1]
    if (last && last.tone === tone && last.dim === dim) {
      last.text += cell.glyph
      continue
    }
    runs.push({ key: `${runs.length}-${cell.zone}`, text: cell.glyph, tone, dim })
  }

  return (
    <Box flexDirection="row" flexShrink={0}>
      {runs.map((run) => (
        <Text key={run.key} color={run.tone} dimColor={run.dim}>
          {run.text}
        </Text>
      ))}
    </Box>
  )
}

export default ProgressBar
