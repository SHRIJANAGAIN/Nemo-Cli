/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Box, Text } from "ink"
import { g } from "./glyphs.js"
import { mixRgb, parseHex, rgbToHex, useThemeColors } from "./themeColors.js"
import { useTicker } from "./use-animation-clock.js"
import type { HarnessStatus } from "../../../../apps/runtime/src/agent/harness-status.js"

/**
 * One animated row under the welcome clock: what `impro` has learned and what
 * it is doing right now.
 *
 * Motion is deliberate, not decorative: a light sweeps across the line only
 * while something is happening (a session-end run is queued, or a harness was
 * adopted in the last few minutes) and the line is revealed character by
 * character on first paint. An idle screen stays static — the welcome frame
 * repaints on every Ink render, and a forever-animating line is exactly the
 * kind of 24/7 repaint that stacks frames in ConPTY scrollback.
 */

export const ACTIVE_TICK_MS = 220
export const IDLE_TICK_MS = 1_500
/** How long after adoption the line keeps animating ("fresh"). */
export const FRESH_WINDOW_MS = 10 * 60 * 1000
/** The sweep runs for a few seconds, then the row settles (no 24/7 repaint). */
export const SWEEP_WINDOW_MS = 6_000

export function formatAgo(ms: number): string {
  if (ms < 60_000) return "just now"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** The plain text of the row (no colour, no animation). "" hides the row. */
export function harnessStatusText(status: HarnessStatus, now: number = Date.now()): string {
  const star = g("star")
  if (status.pending > 0) {
    return `${g("spinnerDot")} impro · learning from the last session`
  }
  if (status.lessons > 0) {
    const lessons = `${status.lessons} lesson${status.lessons === 1 ? "" : "s"}`
    const age = status.adoptedAt ? ` · adopted ${formatAgo(now - status.adoptedAt)}` : ""
    return `${star} impro · ${lessons}${age}`
  }
  return ""
}

const RESET = "\x1b[0m"
const REVEAL_CHAR_MS = 16

const sgr = (hex: string): string =>
  `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`

/** Per-character colour ramp: a soft travelling highlight over muted text. */
export function paintSweep(text: string, wave: number, baseHex: string, hotHex: string): string {
  const base = parseHex(baseHex)
  const hot = parseHex(hotHex)
  if (!base || !hot || text.length === 0) return text
  const chars = [...text]
  const width = 0.26
  const body = chars
    .map((char, index) => {
      const at = chars.length <= 1 ? 0 : index / (chars.length - 1)
      // Circular distance so the highlight re-enters from the left edge.
      const raw = Math.abs(at - wave)
      const distance = Math.min(raw, 1 - raw)
      const glow = distance >= width ? 0 : 1 - distance / width
      return `${sgr(rgbToHex(mixRgb(base, hot, glow * glow)))}${char}`
    })
    .join("")
  return `${body}${RESET}`
}

export interface HarnessStatusLineProps {
  status: HarnessStatus
  /** Frame width in cells; the row never exceeds it. */
  width?: number
}

export function HarnessStatusLine({ status, width = 80 }: HarnessStatusLineProps): ReactNode {
  const theme = useThemeColors()
  const [now, setNow] = useState(() => Date.now())
  const startedAt = useRef(now)
  const fresh = status.adoptedAt !== undefined && now - status.adoptedAt < FRESH_WINDOW_MS
  // A pending run animates for as long as it is queued; an adoption animates
  // only through its reveal + sweep, then the row goes still.
  const sweeping = status.pending > 0 || (fresh && now - startedAt.current < SWEEP_WINDOW_MS)
  const ticking = sweeping || (fresh && now - startedAt.current < SWEEP_WINDOW_MS + 1_000)

  // Wall time, so `useTicker` and not `useAnimationClock`: this row reads
  // "adopted 3s ago", and a motion preference is allowed to stop the sweep,
  // never to freeze the age. The cadence comes off the shared clock instead of
  // a private interval, so its repaint lands in the same commit as every other
  // live row rather than forcing a partial write of its own.
  const tick = useTicker(ticking ? ACTIVE_TICK_MS : IDLE_TICK_MS)

  // One `Date.now()` per tick, not per render: `now` feeds the paint memo, so a
  // value that moved on every unrelated parent re-render would repaint the row
  // constantly.
  useEffect(() => {
    setNow(Date.now())
  }, [tick])

  // A newly adopted harness re-runs the reveal, so an improvement that lands
  // while the app is open animates in instead of silently appearing.
  useEffect(() => {
    startedAt.current = Date.now()
    setNow(Date.now())
  }, [status.adoptedAt])

  const text = harnessStatusText(status, now)
  const painted = useMemo(() => {
    if (!text) return ""
    const max = Math.max(12, width - 2)
    const chars = [...text]
    // Type-in on first paint; a long-finished adoption is simply shown.
    const elapsed = now - startedAt.current
    const reveal = fresh ? Math.min(chars.length, Math.floor(elapsed / REVEAL_CHAR_MS)) : chars.length
    const visible = chars.slice(0, Math.min(reveal, max)).join("")
    if (!sweeping || reveal < chars.length) return visible
    const wave = (elapsed % 2400) / 2400
    return paintSweep(visible, wave, theme.textMuted, theme.accent)
  }, [text, width, sweeping, fresh, now, theme.textMuted, theme.accent])

  if (!text) return null
  return (
    <Box marginTop={1}>
      <Text wrap="truncate">{painted}</Text>
    </Box>
  )
}

export default HarnessStatusLine
