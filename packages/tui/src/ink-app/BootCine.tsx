/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */
import React, { type ReactNode, useEffect, useState } from "react"
import { Box, Text } from "ink"
import { useAppInput } from "./useAppInput.js"
import { isEnter } from "./keys.js"

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
export function bootCineEye(frame: number): CineEye {
  const stage = Math.min(3, Math.floor(Math.max(0, frame) / 4))
  if (stage === 0) return { eye: "( - )", color: "#5b6b82", showTagline: false }
  if (stage === 1) return { eye: "( o )", color: "#8fa3c0", showTagline: false }
  if (stage === 2) return { eye: "( O )", color: "#e0a83c", showTagline: false }
  return { eye: "( ◉ )", color: "#ff4d4d", showTagline: true }
}

/** Title sweep position: one letter burns bright, the rest hold dim. */
export function cineTitleHot(frame: number, length: number): number {
  if (length <= 0) return 0
  return ((frame % length) + length) % length
}

const TITLE = "T R A Y A M B A K"

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

  const eye = bootCineEye(frame)
  const hot = cineTitleHot(frame, TITLE.length)
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
              <Text key={i} color={i === hot ? "#ffd166" : "#3d4b63"}>
                {ch}
              </Text>
            ),
          )}
        </Text>
      </Box>
      <Box marginTop={1} height={1}>
        {eye.showTagline ? <Text dimColor>three eyes of Shiva is coming</Text> : <Text> </Text>}
      </Box>
    </Box>
  )
}

export default BootCine
