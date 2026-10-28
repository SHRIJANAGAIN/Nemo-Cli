/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { useEffect, useState, type ReactNode } from "react"
import os from "node:os"
import { Box, Text } from "ink"
import { useThemeColors } from "./themeColors.js"
import { NemoLogo } from "./NemoLogo.js"
import { ThemeFill } from "./ThemeFill.js"
import { glyphSet } from "./glyphs.js"
import { idleGlyph } from "./use-idle-breathe.js"
import { useAnimationClock, useMotionLevel, useTicker } from "./use-animation-clock.js"
import { motionTravels } from "./animations.js"
import { HarnessStatusLine } from "./HarnessStatusLine.js"
import { readHarnessStatus, type HarnessStatus } from "../../../../apps/runtime/src/agent/harness-status.js"

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
 *  "Welcome To Nemo CLI" banner line. */
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
 *  folder it is in. Returns "" for the home directory itself (see isHomeDir).
 *  The home override exists so tests never depend on the developer's own
 *  home folder. */
export function shortPath(cwd: string | undefined, homeDir?: string): string {
  if (!cwd) return ""
  if (isHomeDir(cwd, homeDir)) return ""
  let trimmed = cwd
  while (trimmed.endsWith("\\") || trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1)
  if (!trimmed) return ""
  const parts = trimmed.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1]! : trimmed
}

/**
 * True when the path is the user's own home (or a filesystem root): the
 * "main directory" carries no project identity, so the Directory line hides
 * there instead of stating the obvious ("Directory  engli"). Home comparison
 * is case-insensitive on Windows, where C:\Users\Engli and c:\users\engli
 * are the same folder.
 */
export function isHomeDir(cwd: string, homeDir?: string): boolean {
  // Normalize separators first: "c:/users/engli" and "c:\users\engli" are the
  // same folder, and without this the comparison below misses mixed inputs.
  const norm = (p: string): string => {
    let out = p.replace(/\//g, "\\")
    while (out.endsWith("\\")) out = out.slice(0, -1)
    return out.toLowerCase()
  }
  const trimmed = norm(cwd)
  // An all-separator input normalizes to "" — that IS the filesystem root,
  // while a truly empty input is not.
  if (!trimmed) return /^[\\/]+$/.test(cwd)
  if (/^[a-z]:$/.test(trimmed)) return true
  try {
    const home = homeDir ?? os.homedir()
    if (home && norm(home) === trimmed) return true
  } catch {
    /* os.homedir can throw without a HOME — fall through, not home. */
  }
  return false
}

export function WelcomeScreen({ cwd, fillRows = 0, width = 80, logoCompact = false }: WelcomeScreenProps): ReactNode {
  const theme = useThemeColors()
  const [harness, setHarness] = useState<HarnessStatus>(() => readHarnessStatus())
  // Two clocks, because this screen shows two different kinds of thing and one
  // interval used to drive both — which meant a motion preference that should
  // only ever have stilled the shimmer also froze the displayed time.
  //
  // The date and time are INFORMATION: `useTicker`, off the shared clock but out
  // of the motion policy's reach, so `NEMO_MOTION=off` keeps the second
  // honest instead of parking it at whatever it read on the way out.
  useTicker(WELCOME_CYCLE_MS)
  const now = new Date()
  // The logo sweep and the twinkling directory glyph are DECORATION, and they
  // split on the one axis that matters for motion sensitivity: POSITION versus
  // BRIGHTNESS. A band travelling across the logo changes position, so it is for
  // `full` only — `reduced` hands `logoShimmer` a 0 phase, which is its static,
  // fully legible art. A glyph twinkling in place changes only brightness, so it
  // keeps breathing on the slowed `reduced` cycle. `off` stops both, because it
  // installs no timer at all.
  const motion = useMotionLevel()
  const cycle = useAnimationClock(WELCOME_CYCLE_MS)
  const phaseMs = motionTravels(motion) ? cycle * WELCOME_CYCLE_MS : 0
  useEffect(() => {
    // The library is written by a detached child; a slow poll picks up an
    // adoption that lands while this screen is open. Cached in the reader.
    const timer = setInterval(() => setHarness(readHarnessStatus()), 15_000)
    return () => clearInterval(timer)
  }, [])
  const dir = shortPath(cwd)
  // The impro row costs two rows (one blank spacer + one text row). It only
  // appears when the viewport has slack for it: an exact-fit welcome frame
  // must never start scrolling, because scrollback clones are the failure
  // mode this layout exists to prevent.
  const showHarness = (harness.lessons > 0 || harness.pending > 0) && fillRows >= 2
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {/* One full-width slot for the logo: it owns the WHOLE frame width so
          its truncate can never claim a border column, and the banner's own
          raster decides where the mark sits. Everything below is left-aligned
          to match it — logo and the status block share one column. */}
      <NemoLogo compact={logoCompact} width={width} phaseMs={phaseMs} />

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
            {/* Twinkling lead-in on the same cycle as the starfield: the glyph
                itself changes, so the row still moves on colourless output — and
                when motion is off it holds a still glyph instead of twinkling. */}
            <Text color={theme.text}>
              {idleGlyph(cycle, glyphSet() === "ascii")}{" "}
            </Text>
            {"Directory  "}
            {dir}
          </Text>
        ) : null}
        {showHarness ? <HarnessStatusLine status={harness} width={width} /> : null}
      </Box>

      {/* The banner's own rows are padded to the frame width with the theme
          background inside NemoLogo (width), so no terminal-black strip
          survives beside the mark. Everything below it is painted the same
          way, because Ink writes nothing for a row that holds no text.
          Stars are disabled on request: the fill is a plain theme background
          (one cell of slack, same as the banner, so Ink never truncates). */}
      {fillRows > 0 ? (
        <ThemeFill
          rows={showHarness ? Math.max(0, fillRows - 2) : fillRows}
          width={Math.max(1, width - 1)}
          background={theme.background}
        />
      ) : null}
    </Box>
  )
}

export default WelcomeScreen
