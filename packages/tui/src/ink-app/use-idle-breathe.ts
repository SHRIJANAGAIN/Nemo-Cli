/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { useAnimationClock } from "./use-animation-clock.js"

/**
 * Opt-in idle "breathe" for the footer + composer.
 *
 * Idle-silence is the default contract: at rest the TUI writes ZERO bytes so
 * the terminal owns the viewport natively (Windows scrollbar + native drag
 * hold position — a ~2Hz caret blink used to yank every native scroll back
 * to the cursor). Any idle timer breaks that, so this animation is strictly
 * opt-in via `NEMO_IDLE_ANIM=1` and OFF otherwise — callers gate their
 * interval on `idleAnimEnabled()` and the frame stays byte-identical when
 * the flag is absent.
 *
 * When ON: a slow (~0.9s) silver breathe — footer border + status dot drift
 * through steel-to-bright-silver, the composer's prompt star twinkles beside
 * the placeholder. Same S1-TITANIUM metal as the logo starfield, never hue.
 */

export const IDLE_ANIM_ENV = "NEMO_IDLE_ANIM"

/** One breathe step: slow enough to read as calm, fast enough to feel alive. */
export const IDLE_BREATHE_TICK_MS = 900

/** Silver breathe ramp: steel shadows -> bright silver crest -> steel. */
export const IDLE_SILVER: readonly string[] = ["#9FB2C8", "#C9D4E0", "#E8EEF4", "#F5F8FB", "#E8EEF4", "#C9D4E0"]

export type IdleEnvSource = Readonly<Record<string, string | undefined>>

/**
 * True only for an explicit on-spelling (`1`/`true`/`on`/`yes`). Absent,
 * empty, `0`/`false`/`off`/`no`, or anything unrecognized means OFF — a typo
 * must never silently start repainting idle frames.
 */
export function idleAnimEnabled(source: IdleEnvSource = process.env): boolean {
  const raw = source[IDLE_ANIM_ENV]
  if (raw === undefined) return false
  const value = raw.trim().toLowerCase()
  return value === "1" || value === "true" || value === "on" || value === "yes"
}

/** Silver for this breathe frame. Tick may be any integer (negatives wrap). */
export function idleSilver(tick: number): string {
  const n = IDLE_SILVER.length
  return IDLE_SILVER[((tick % n) + n) % n] as string
}

/** Twinkle cycle for the idle marks. The GLYPH changes, not just its colour:
 *  a colour-only breathe is invisible where SGR is dropped (piped output,
 *  NO_COLOR, the vitest stream), and those are exactly the places the frame
 *  would otherwise look frozen. Every frame is width-1 in both sets. */
export const IDLE_GLYPHS: readonly string[] = ["✦", "✧", "·", "✧"]
export const IDLE_GLYPHS_ASCII: readonly string[] = ["+", "*", ".", "*"]

export function idleGlyph(tick: number, ascii = false): string {
  const set = ascii ? IDLE_GLYPHS_ASCII : IDLE_GLYPHS
  return set[((tick % set.length) + set.length) % set.length] as string
}

/**
 * Breathe frame counter, off the shared frame clock. The clock subscription
 * exists ONLY while `active` — inactive renders install no timer, so the
 * default (flag off) frame writes nothing.
 */
export function useIdleBreathe(active: boolean): number {
  return useAnimationClock(IDLE_BREATHE_TICK_MS, active)
}

export default useIdleBreathe
