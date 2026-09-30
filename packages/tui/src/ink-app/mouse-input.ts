/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Wheel/touch-scroll events parsed out of stdin by StdinSanitizer.
 *
 * App enables SGR mouse reporting (1000+1006) for the TUI's lifetime, so
 * the terminal ships clicks and wheel notches as byte sequences. Those must
 * NEVER reach Ink's key parser (it would "type" them into the composer);
 * the sanitizer strips them and re-emits wheel direction through this tiny
 * bus. Touch: terminals map touch-scroll gestures to the same wheel events
 * and taps to button reports (swallowed as no-ops), which is what makes
 * the transcript touch-scrollable.
 */

import { appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

export type MouseScrollDir = "up" | "down"

type Listener = (dir: MouseScrollDir) => void

const listeners = new Set<Listener>()

/** Subscribe to wheel scrolls; returns an unsubscribe function. */
export const onMouseScroll = (fn: Listener): (() => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Called by the stdin layer — never by UI code. */
export const emitMouseScroll = (dir: MouseScrollDir): void => {
  // Diagnostic: a MOUSE-RAW line here proves terminal wheel bytes ARRIVED
  // and were parsed (if it's missing while wheel-scrolling does nothing,
  // the terminal never sent reports — check ESC[?1000h was honoured).
  if (process.env.TRAYAMBAK_DEBUG_INPUT === "1") {
    try {
      appendFileSync(path.join(tmpdir(), "trayambak-input.log"), `${new Date().toISOString()} MOUSE-RAW ${dir}\n`)
    } catch {
      /* logging must never block the stdin pipeline */
    }
  }
  for (const fn of listeners) {
    try {
      fn(dir)
    } catch {
      /* a listener must never break the stdin pipeline */
    }
  }
}
