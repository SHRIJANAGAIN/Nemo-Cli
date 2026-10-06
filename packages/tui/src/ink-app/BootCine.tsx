/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */
import React, { type ReactNode, useEffect, useState } from "react"
import { Box, Text } from "ink"
import { useAppInput } from "./useAppInput.js"
import { isEnter } from "./keys.js"
import { cinePalette, useThemeColors, type CinePalette } from "./themeColors.js"
import { VERSION } from "../../../../apps/cli/src/version.js"
import { bootCodename } from "./thinking-ribbon.js"

export interface BootCineProps {
  /** Advance past the cinematic (timer expiry or any keypress both call this). */
  onDone: () => void
  /** Milliseconds before auto-advance. No timer is ever displayed. */
  durationMs?: number
}

/** Frame tick: brisk enough to feel alive, slow enough to read the eye. */
export const BOOT_CINE_TICK_MS = 150

export interface CineEye {
  /** The eye glyph line for this frame. */
  eye: string
  /** Glow colour for the eye line. */
  color: string
  /** Tagline already revealed. */
  showTagline: boolean
}

/**
 * Pure eye stage for a frame index (unit-tested): shut → stirring →
 * half-open → BLAZING, then holds open. Clamped (never loops back shut),
 * so the stage is a pure function of the tick count and never depends on
 * mount timing.
 */
export function bootCineEye(frame: number, palette: CinePalette): CineEye {
  const stage = Math.min(3, Math.floor(Math.max(0, frame) / 4))
  if (stage === 0) return { eye: "( - )", color: palette.shut, showTagline: false }
  if (stage === 1) return { eye: "( o )", color: palette.stirring, showTagline: false }
  if (stage === 2) return { eye: "( O )", color: palette.half, showTagline: false }
  return { eye: "( ◉ )", color: palette.blazing, showTagline: true }
}

/** Title sweep position: one letter burns bright, the rest hold dim. */
export function cineTitleHot(frame: number, length: number): number {
  if (length <= 0) return 0
  return ((frame % length) + length) % length
}

/** Paint for one title letter: the sweep burns `hot`, everything else holds `cold`. */
export function cineTitleColor(index: number, hot: number, palette: CinePalette): string {
  return index === hot ? palette.hot : palette.cold
}

/**
 * Codename row for a frame: the name types itself in from the left, one
 * character every two ticks, and the NOT-yet-typed cells stay as spaces.
 *
 * Fixed width on purpose — the row is reserved from frame 0, so the tagline
 * above and the composer below never shift as the text lands. Returns a copy;
 * callers may not mutate the caller's string.
 */
export function cineCodenameRow(frame: number, name: string): string[] {
  const chars = [...name]
  const shown = Math.min(chars.length, Math.floor(Math.max(0, frame) / 2) + 1)
  return chars.map((ch, i) => (i < shown ? ch : " "))
}

const TITLE = "T R A Y A M B A K"

/** Build codename shown under the title, e.g. "S1-TITANIUM". Falls back to
 *  the bare version when the stamp is missing (a dev run without a build). */
const CODENAME = bootCodename(VERSION || "dev")

/**
 * Boot cinematic — plays on EVERY launch for returning users (first-run
 * keeps its own SplashScreen): the third eye opens in stages under a
 * sweeping title, then the welcome/transcript takes over. Any key skips;
 * the timer auto-advances. Short by design — this is a knock, not a movie.
 */
export function BootCine({ onDone, durationMs = 2600 }: BootCineProps): ReactNode {
  const [frame, setFrame] = useState(0)
  const doneRef = React.useRef(onDone)
  doneRef.current = onDone

  useEffect(() => {
    const timer = setTimeout(() => doneRef.current(), durationMs)
    const tick = setInterval(() => setFrame((f) => f + 1), BOOT_CINE_TICK_MS)
    return () => {
      clearTimeout(timer)
      clearInterval(tick)
    }
  }, [durationMs])

  useAppInput((input, key) => {
    if (isEnter(input, key) || key.escape || key.return || (input && input.length > 0)) {
      doneRef.current()
    }
  })

  const theme = useThemeColors()
  const palette = cinePalette(theme)
  const eye = bootCineEye(frame, palette)
  const hot = cineTitleHot(frame, TITLE.length)
  // The codename types itself in from the left and lands hot on its last
  // glyph, mirroring the title sweep. Reserved as a blank row before that so
  // the block never jumps (see cineCodenameRow).
  const codenameChars = cineCodenameRow(frame, CODENAME)
  return (
    <Box flexDirection="column" height="100%" alignItems="center" justifyContent="center">
      <Box>
        <Text bold color={eye.color}>
          {eye.eye}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text bold>
          {TITLE.split("").map((ch, i) =>
            ch === " " ? (
              <Text key={i}> </Text>
            ) : (
              <Text key={i} color={cineTitleColor(i, hot, palette)}>
                {ch}
              </Text>
            ),
          )}
        </Text>
      </Box>
      <Box marginTop={1} height={1}>
        {eye.showTagline ? <Text dimColor>three eyes of Shiva is coming</Text> : <Text> </Text>}
      </Box>
      {/* Build identity: the S-series codename rides in from the left as the
          eye finishes opening, so every launch states which build it is
          without stealing a line from the title. `versionChipText` already
          turns "1.0.0-S1-TITANIUM" into "S1-TITANIUM". */}
      <Box marginTop={1} height={1}>
        {codenameChars.map((ch, i) => (
          <Text
            key={i}
            bold={i === codenameChars.length - 1}
            color={i === codenameChars.length - 1 ? palette.blazing : palette.cold}
          >
            {ch}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

export default BootCine
