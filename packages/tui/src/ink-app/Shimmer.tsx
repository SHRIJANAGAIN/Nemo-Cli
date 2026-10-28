/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { type ReactNode } from "react"
import { Text } from "ink"
import { mixRgb, parseHex, rgbToHex, useThemeColors } from "./themeColors.js"
import type { Rgb } from "../ui/theme.js"
import { shimmerIntensities } from "./animations.js"
import { useAnimationClock, useTravel } from "./use-animation-clock.js"
import { graphemes } from "./utils/stringWidth.js"

export interface ShimmerProps {
  text: string
  /** Base colour (defaults to the muted text token — a shimmer on full-bright
   *  text has nowhere to go). */
  color?: string
  /** Colour the band travels toward (defaults to the theme accent). */
  glow?: string
  /** Band width in cells. */
  band?: number
  /** ms per cell of travel. */
  intervalMs?: number
  bold?: boolean
}

/**
 * A highlight band sweeping across a label.
 *
 * Colour is mixed per cell, so the band is a gradient rather than the bold/dim
 * flip-flop that reads as flicker on a terminal with no antialiasing. Every frame
 * is a true 24-bit hex, so no colour-256 quantisation banding either.
 *
 * With travelling motion disabled the label renders in its base colour: the text
 * stays legible, only the sweep stops.
 */
export function Shimmer({ text, color, glow, band = 4, intervalMs = 110, bold = false }: ShimmerProps): ReactNode {
  const theme = useThemeColors()
  const cells = graphemes(text)
  const base = parseHex(color ?? theme.textMuted)
  const bright = parseHex(glow ?? theme.accent)
  const travel = useTravel(cells.length > band)
  const tick = useAnimationClock(intervalMs, travel)

  // Malformed colours (a theme token that is not a #rrggbb) fall back to plain
  // text rather than painting "undefined" into the frame.
  if (!travel || !base || !bright) {
    return (
      <Text color={color ?? theme.textMuted} bold={bold}>
        {text}
      </Text>
    )
  }

  const intensities = shimmerIntensities(cells.length, tick, { width: band })
  return (
    <Text bold={bold}>
      {cells.map((cell, i) => (
        <Text key={i} color={mix(base, bright, intensities[i] ?? 0)}>
          {cell}
        </Text>
      ))}
    </Text>
  )
}

function mix(from: Rgb, to: Rgb, t: number): string {
  return rgbToHex(mixRgb(from, to, t))
}

export default Shimmer
