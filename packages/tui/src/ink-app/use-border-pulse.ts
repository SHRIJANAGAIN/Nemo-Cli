/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { useEffect, useState } from "react"

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
 * Finished/pending boxes pass active=false and stay put — and the timer
 * is torn down with the box, so it can never keep a completed frame
 * churning.
 *
 * The palette is passed as an array but compared by CONTENTS, not
 * identity or length — callers build it inline from the theme each render,
 * and re-creating the array must neither restart the interval nor miss a
 * theme switch that keeps the same length (stale border until next tick).
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

export function useBorderPulse(active: boolean, palette: string[], dim: string): PulseEdges {
  const [tick, setTick] = useState(0)
  const key = palette.join("|")

  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      setTick((t) => t + 1)
    }, PULSE_MS)
    return () => clearInterval(timer)
  }, [active, key])

  if (!active || palette.length === 0) {
    const color = palette[0] ?? dim
    return { color, top: color, right: color, bottom: color, left: color }
  }
  const lit = tick % 4 // 0 = top, 1 = right, 2 = bottom, 3 = left
  const color = palette[tick % palette.length]
  return {
    color,
    top: lit === 0 ? color : dim,
    right: lit === 1 ? color : dim,
    bottom: lit === 2 ? color : dim,
    left: lit === 3 ? color : dim,
  }
}

export default useBorderPulse
