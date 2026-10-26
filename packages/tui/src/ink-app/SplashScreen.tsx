/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import React, { type ReactNode, useEffect, useRef } from "react"
import { Box, Text } from "ink"
import { useAppInput } from "./useAppInput.js"
import { isEnter } from "./keys.js"
import { NemoLogo } from "./NemoLogo.js"
import { g, spinnerFrames } from "./glyphs.js"
import { cycleIndex } from "./animations.js"
import { useAnimationClock, useMotionLevel } from "./use-animation-clock.js"

export interface SplashScreenProps {
  /** Advance past the splash (timer expiry or keypress both call this). */
  onDone: () => void
  /** Milliseconds before auto-advance. No timer is ever displayed. */
  durationMs?: number
}

const SPINNER: string[] = spinnerFrames()
const SPIN_MS = 120

/**
 * First-run welcome splash (codex-style Welcome step): the SAME ASCII logo
 * the chat's WelcomeScreen shows (logo_ansi.txt via NemoLogo — the old
 * pixel "feather" mark was removed on request: the logo must be the one
 * from the chat), then "Welcome to Nemo CLI!" and the warm-up spinner.
 * Any key skips; the timer auto-advances. The duration is never displayed.
 */
export function SplashScreen({ onDone, durationMs = 10_000 }: SplashScreenProps): ReactNode {
  // The spin reads the shared clock, so it is in phase with every other live
  // widget and stops under NEMO_MOTION=off. The timeout is a one-shot
  // deadline, not an animation, so it stays a plain timer.
  // Stopping is not the same as parking: `off` must not leave a braille cell
  // frozen mid-rotation, because a glyph that looks stuck reads as a broken
  // terminal rather than as a settled preference. The resting frame swaps it for
  // a theme-safe dot and lets the sentence carry the wait on its own.
  const animating = useMotionLevel() !== "off"
  const frame = useAnimationClock(SPIN_MS, animating)
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  useEffect(() => {
    const timer = setTimeout(() => doneRef.current(), durationMs)
    return () => clearTimeout(timer)
  }, [durationMs])

  useAppInput((input, key) => {
    if (isEnter(input, key) || key.escape || key.return || (input && input.length > 0)) {
      doneRef.current()
    }
  })

  return (
    <Box flexDirection="column" height="100%" alignItems="center" justifyContent="center">
      <Box flexDirection="column" alignItems="center" marginBottom={1}>
        <NemoLogo compact={false} />
      </Box>
      <Text bold color="#6cb6f5">
        Welcome to Nemo CLI!
      </Text>
      <Text dimColor>by Shrijan</Text>
      <Box marginTop={1}>
        {/* bold: the warm-up glyph must carry the wait ("animation bada /
            bolder") — a hairline braille cell at 120ms read as noise. */}
        <Text bold color="#6cb6f5">
          {animating ? SPINNER[cycleIndex(frame, SPINNER.length)] : g("dot")}
        </Text>
        <Text dimColor> Setting things up…</Text>
      </Box>
    </Box>
  )
}
export default SplashScreen
