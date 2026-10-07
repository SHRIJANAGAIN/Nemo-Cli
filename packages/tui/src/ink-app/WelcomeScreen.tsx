/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import React, { useEffect, useState, type ReactNode } from "react"
import { Box, Text } from "ink"
import { useThemeColors } from "./themeColors.js"
import { TrayambakLogo } from "./TrayambakLogo.js"
import { ThemeFill } from "./ThemeFill.js"

export interface WelcomeScreenProps {
  permissionMode?: string
  cwd?: string
  tokenCount?: number
  /** Empty rows below the status block to paint with the theme background
   *  (Ink writes no background on empty rows — see ThemeFill). */
  fillRows?: number
  /** Usable width in cells for those fill rows. */
  width?: number
  /** One-line mark instead of the full lockup on short viewports: the 8-row
   *  banner no longer fits the idle frame there, and an overflowing frame
   *  scrolls on every repaint (that scroll is the clone mechanism). */
  logoCompact?: boolean
}

/** Idle-home tick (~0.5 s): advances the live clock and drives the starfield
 *  twinkle, so the first screen isn't a frozen poster. The TIME is what
 *  changes each tick, so it stays honest wall-clock time, not a loop. */
const WELCOME_CYCLE_MS = 500

/** Live local clock under the logo — replaces the old static
 *  "Welcome To Trayambak CLI" banner line. */
export function formatClock(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0")
  const mm = String(date.getMinutes()).padStart(2, "0")
  const ss = String(date.getSeconds()).padStart(2, "0")
  return `${hh}:${mm}:${ss}`
}

/** Weekday + day + month, so the clock is not a bare number (ASCII only: the
 *  weekday/month names never carry accents, so no mojibake on legacy
 *  codepage consoles the way the rest of the UI's marks are guarded). */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const

export function formatDate(date: Date): string {
  return `${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()}`
}

/** Direct folder name of a path — the only part worth showing on a status
 *  line. A full path ("C:\Users\engli\my-project") is noise here: the footer
 *  already carries the full context, and the eye only wants to know WHICH
 *  folder it is in. Pure (unit-tested) — no cwd guessing in the render. */
export function shortPath(cwd: string | undefined): string {
  if (!cwd) return ""
  const trimmed = cwd.replace(/[\\/]+$/, "")
  if (!trimmed) return ""
  const parts = trimmed.split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1]! : trimmed
}

export function WelcomeScreen({ cwd, fillRows = 0, width = 80, logoCompact = false }: WelcomeScreenProps): ReactNode {
  const theme = useThemeColors()
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    // One interval drives BOTH the displayed second and the hue breath, so the
    // idle screen still repaints while the clock advances.
    const timer = setInterval(() => {
      setNow(new Date())
    }, WELCOME_CYCLE_MS)
    return () => clearInterval(timer)
  }, [])
  const dir = shortPath(cwd)
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {/* One full-width slot for the logo: it owns the WHOLE frame width so
          its truncate can never claim a border column, and the banner's own
          raster decides where the mark sits. Everything below is left-aligned
          to match it — logo and the status block share one column. */}
      <TrayambakLogo compact={logoCompact} width={width} phaseMs={now.getTime()} />

      {/* Time + folder only, all in silver. The model name is deliberately NOT
          repeated here: the footer chip already states it on every frame, and
          two copies of the same fact read as clutter. The clock stays a solid
          silver (no hue cycling) — the twinkling starfield above carries the
          motion, so the status block reads as calm metal. */}
      <Box flexDirection="column" alignItems="flex-start" marginTop={1}>
        <Text bold color={theme.text}>
          {formatDate(now)} {formatClock(now)}
        </Text>
        {dir ? (
          <Text color={theme.textMuted}>
            {"Directory  "}
            {dir}
          </Text>
        ) : null}
      </Box>

      {/* The banner's own rows are padded to the frame width with the theme
          background inside TrayambakLogo (width), so no terminal-black strip
          survives beside the mark. Everything below it is painted the same
          way, because Ink writes nothing for a row that holds no text. */}
      {fillRows > 0 ? <ThemeFill rows={fillRows} background={theme.background} width={width} /> : null}
    </Box>
  )
}

export default WelcomeScreen
