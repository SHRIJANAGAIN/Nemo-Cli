/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Wheel-offset math for the in-app history window (MessageList takes the
 * offset as "messages behind the live end"; 0 = live).
 *
 * Two invariants the UI must hold ("history ke liye wo hide nahi chahiye —
 * pura show hota rahe"):
 *  - a notch moves the window in fixed steps and clamps to message 0 / live;
 *  - the reading position is ANCHORED: every message appended BEHIND a
 *    scrolled window (tool rows land two-per-call mid-turn!) bumps the
 *    offset by the same delta, so endIdx = count − scrollBack — and the
 *    exact rows being read — never slide toward live and drop out of frame.
 *
 * Two input paths share one clamp: the WHEEL moves 3 messages per notch
 * (mouse-input bus), PageUp/PageDown jumps 10 (PromptInput's onHistoryScroll
 * — "easy scrollable": one keypress pages through history instead of
 * notching). The offset persists across turn end (App only snaps to live on
 * the NEXT turn), so a parked reading position stays parked and stays
 * scrollable.
 *
 * Pure functions (unit-tested in scroll-math.test.ts); App owns the state.
 */

import type { MouseScrollDir } from "./mouse-input.js"

/** Shared slide: `step` messages toward the first message (max =
 *  count − 1 → endIdx 1) on the way up, toward live (0) on the way down. */
function slideOffset(dir: MouseScrollDir, scrollBack: number, messageCount: number, step: number): number {
  const max = Math.max(0, messageCount - 1)
  return dir === "up" ? Math.min(max, scrollBack + step) : Math.max(0, scrollBack - step)
}

/** One wheel notch = 3 messages (see slideOffset for the clamps). */
export function wheelScrollOffset(dir: MouseScrollDir, scrollBack: number, messageCount: number): number {
  return slideOffset(dir, scrollBack, messageCount, 3)
}

/** One PageUp/PageDown press = 10 messages — same clamps, bigger stride,
 *  so long transcripts page through quickly without a wheel marathon. */
export function pageScrollOffset(dir: MouseScrollDir, scrollBack: number, messageCount: number): number {
  return slideOffset(dir, scrollBack, messageCount, 10)
}

/** Growth compensation: `messages` grew from prevCount to count while the
 *  window is scrolled — shift the offset by the delta so the window's END
 *  (count − offset) stays exactly where the user pinned it. Live (0) stays
 *  live (the frame should follow the turn); shrink/wholesale replaces never
 *  move it (the staticEpoch reset owns those). */
export function scrollOffsetAfterGrowth(prevCount: number, count: number, scrollBack: number): number {
  const delta = count - prevCount
  if (delta <= 0 || scrollBack <= 0) return scrollBack
  return Math.min(scrollBack + delta, Math.max(0, count - 1))
}
