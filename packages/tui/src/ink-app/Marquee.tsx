/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { type ReactNode } from "react"
import { Text } from "ink"
import { marquee } from "./animations.js"
import { useAnimationClock, useTravel } from "./use-animation-clock.js"
import { sliceByWidth, stringWidth } from "./utils/stringWidth.js"

export interface MarqueeProps {
  text: string
  /** Viewport in cells. Output is always exactly this wide when `width` > 0. */
  width: number
  /** ms per scroll step. Default 320 — ~3 cells a second, readable at a glance
   *  and slow enough not to blur. */
  intervalMs?: number
  /** Ticks to hold at each end before turning around. */
  hold?: number
  /** Gap between repeats when the text is shorter than the scroll run. */
  gap?: number
  color?: string
  dimColor?: boolean
  bold?: boolean
}

/**
 * Scroll a label that does not fit its column, instead of truncating it.
 *
 * Two behaviours matter and are easy to get wrong: text that FITS is never
 * scrolled (a scrolling static label is the single most common marquee bug), and
 * the scroll is grapheme-safe, so a CJK model name or an emoji in a path cannot
 * be sliced in half — `sliceByWidth` measures cells, `String.slice` does not.
 *
 * Reduced motion falls back to the truncated label: the information stays
 * reachable, only the travel goes away.
 */
export function Marquee({
  text,
  width,
  intervalMs = 320,
  hold = 4,
  gap = 3,
  color,
  dimColor = false,
  bold = false,
}: MarqueeProps): ReactNode {
  const fits = !(width > 0) || stringWidth(text) <= width
  const travel = useTravel(!fits)
  const tick = useAnimationClock(intervalMs, travel)
  const shown = travel ? marquee(text, width, tick, { hold, gap }) : sliceByWidth(text, width)
  return (
    <Text color={color} dimColor={dimColor} bold={bold}>
      {shown}
    </Text>
  )
}

export default Marquee
