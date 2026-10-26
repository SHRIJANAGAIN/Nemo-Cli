/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Duration text — the two shapes a span of time takes on screen, and why they
 * are not the same function.
 *
 * `formatElapsed` counts UP live: it starts at "0s" and never shows
 * sub-second detail, because a readout that repaints every second would jitter
 * its own width ("450ms" → "700ms" → "1s") and shove the rest of the row
 * sideways twice a second. Use it for anything driven by the frame clock.
 *
 * `formatDuration` reports a FINISHED measurement once: it keeps milliseconds
 * for a sub-second span, because "0s" thrown at a 450ms grep tells the user the
 * call was instant when it was not, and one repaint cannot jitter.
 *
 * The bug this split exists to prevent was real: finished tool cards printed
 * raw milliseconds ("• 45231ms") in the exact slot that had shown "12s" while
 * the call ran, so the number got harder to read at the moment it became final.
 */

/** Live counting label: coarse whole units only, stable width within a tier. */
export function formatElapsed(elapsedMs: number): string {
  // A NaN/Infinity here means a caller subtracted a missing timestamp; "NaNs"
  // in a status row is worse than "0s", and it is wider than the frame box.
  const total = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = String(total % 60).padStart(2, "0")
  if (minutes < 60) return `${minutes}m ${seconds}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

/** Finished-measurement label: "450ms" / "12s" / "1m 04s" / "2h 03m". */
export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0
  if (safe < 1000) return `${Math.round(safe)}ms`
  return formatElapsed(safe)
}
