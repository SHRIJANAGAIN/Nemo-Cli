/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { cycleIndex, paletteAt } from "./animations.js"
import { useAnimationClock, useTravel } from "./use-animation-clock.js"

/**
 * Edge-chase border animation for LIVE tool-call boxes ("animation bada
 * do"): every PULSE_MS a light TRIPS around the box — top → right →
 * bottom → left — showing the current palette colour on exactly ONE edge
 * while the other three sit at `dim`. A running box therefore MOVES, not
 * just swaps its whole colour in place (the old flat pulse was a static
 * breath at the same spot; this chases all the way round, so it reads
 * bigger). The palette advances per step too, so the light also changes
 * hue each edge.
 *
 * The tick comes from the shared frame clock, so N running boxes chase in
 * phase off one timer instead of one 160ms interval each. It also means the
 * palette array no longer has to be compared by contents: callers build it
 * inline from the theme every render, and there is no interval left to
 * restart when its identity changes — a `/theme` switch takes effect on the
 * very next step.
 *
 * `active=false` (finished/pending boxes) costs no subscription, and reduced
 * motion falls back to the whole-box colour change: the box still reads as
 * live, nothing travels.
 */
const PULSE_MS = 160

export interface PulseEdges {
  /** Current palette colour — what the lit edge shows this step (also the
   *  whole-box fallback when no edge is lit, e.g. footer's colour-cycle). */
  color: string
  top: string
  right: string
  bottom: string
  left: string
}

function flat(color: string): PulseEdges {
  return { color, top: color, right: color, bottom: color, left: color }
}

export function useBorderPulse(active: boolean, palette: string[], dim: string): PulseEdges {
  const travel = useTravel(active)
  const tick = useAnimationClock(PULSE_MS, active)
  const color = paletteAt(palette, tick, dim)
  if (!active || palette.length === 0 || !travel) return flat(color)
  const lit = cycleIndex(tick, 4) // 0 = top, 1 = right, 2 = bottom, 3 = left
  return {
    color,
    top: lit === 0 ? color : dim,
    right: lit === 1 ? color : dim,
    bottom: lit === 2 ? color : dim,
    left: lit === 3 ? color : dim,
  }
}

export default useBorderPulse
