/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Scroll-window arithmetic for the conversation frame.
 *
 * App owns one number, `scrollBack`: how many messages the live frame sits
 * BEHIND the newest message (0 = live). The frame's window therefore ends at
 *
 *     endIdx = messageCount - scrollBack
 *
 * and every function here exists to keep that window stable and in range.
 * All are pure so the behaviour can be pinned without a terminal.
 */

/** Messages moved per wheel notch. */
export const WHEEL_STRIDE = 3
/** Messages moved per PageUp/PageDown press. */
export const PAGE_STRIDE = 10

/**
 * Largest offset that still leaves one message in the live frame. Scrolling so
 * far that nothing renders would look like a hung UI, so the window always
 * keeps the oldest message visible at the top.
 */
function maxOffset(messageCount: number): number {
  return Math.max(0, messageCount - 1)
}

function clampOffset(value: number, messageCount: number): number {
  if (!Number.isFinite(value)) return 0
  const max = maxOffset(messageCount)
  if (value < 0) return 0
  if (value > max) return max
  return Math.floor(value)
}

/**
 * One wheel notch. `dir` is the direction the user scrolled: "up" walks back
 * into history (offset grows), "down" returns toward live (offset shrinks).
 * Never moves while the wheel sits at either end — clamping, not wrapping.
 */
export function wheelScrollOffset(dir: "up" | "down", current: number, messageCount: number): number {
  const delta = dir === "up" ? WHEEL_STRIDE : -WHEEL_STRIDE
  return clampOffset(current + delta, messageCount)
}

/**
 * One PageUp/PageDown press — a bigger stride through the same offset state,
 * so keyboard and wheel share one clamp and one growth anchor.
 */
export function pageScrollOffset(dir: "up" | "down", current: number, messageCount: number): number {
  const delta = dir === "up" ? PAGE_STRIDE : -PAGE_STRIDE
  return clampOffset(current + delta, messageCount)
}

/**
 * Anchor the window while the transcript grows.
 *
 * When scrolled back, each appended message must be matched by +1 on the
 * offset so `endIdx` stays put — otherwise rows landing behind the window drag
 * the history the user is reading toward live on every tool result, which is
 * exactly the "reading window slid away" bug. Live (offset 0) stays live.
 *
 * Takes lengths rather than arrays because App reads the previous length from
 * a ref during render, before the new array exists.
 */
export function scrollOffsetAfterGrowth(prevLen: number, nextLen: number, current: number): number {
  if (current <= 0) return 0
  const grew = nextLen - prevLen
  if (grew <= 0) return clampOffset(current, nextLen)
  return clampOffset(current + grew, nextLen)
}
