/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The active motion level, as a subscribable store.
 *
 * Kept separate from the pure policy in animations.ts so that file stays free of
 * mutable state (and testable without React), and separate from the theme store
 * so a `/motion off` switch costs the widgets that animate nothing at all.
 *
 * The version-bump + listener set is the same shape `ui/theme.ts` uses for
 * `/theme`: without a subscription a switch would only paint when some unrelated
 * re-render happened to flush, which is exactly how the theme bug behaved before
 * it was fixed.
 */

import { resolveMotion, type MotionLevel } from "./animations.js"

let cached: MotionLevel | null = null
let version = 0
const listeners = new Set<() => void>()

/**
 * The env-resolved default, read once and memoised the way `glyphSet()` reads
 * `NEMO_GLYPHS`. A `setMotionLevel()` call (the `/motion` command, a test)
 * wins over the environment from then on, so an exported `NEMO_MOTION`
 * cannot resurrect motion the user just turned off mid-session.
 */
function fromEnv(): MotionLevel {
  return resolveMotion({ env: process.env })
}

export function getMotionLevel(): MotionLevel {
  if (cached === null) cached = fromEnv()
  return cached
}

/** Snapshot identity for `useSyncExternalStore`: the level itself, bumped by version. */
export function motionVersion(): number {
  return version
}

export function subscribeMotion(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/** Install a level explicitly; notifies subscribers only when it actually changed. */
export function setMotionLevel(next: MotionLevel): void {
  if (cached === next) return
  cached = next
  version += 1
  for (const onChange of [...listeners]) {
    try {
      onChange()
    } catch {
      // A failing listener must not leave the level half-applied.
    }
  }
}

/**
 * Test seam: forget both the memoised env read and any explicit level so a case
 * can pin `NEMO_MOTION` after module load. Production code has no reason to
 * call it — the env read happens at most once by design.
 */
export function resetMotionStoreForTests(): void {
  cached = null
  version += 1
  for (const onChange of [...listeners]) onChange()
}
