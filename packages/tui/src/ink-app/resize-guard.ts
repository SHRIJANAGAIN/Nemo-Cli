/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Width-resize guard for Ink apps: blank the viewport and reset Ink's line
 * bookkeeping so the post-resize redraw starts clean.
 *
 * Root cause this fixes (startup logo/frames piling up in scrollback with
 * shifting widths):
 *
 * Ink erases its previous frame by cursor-up × `split('\n').length` — a
 * LINE count, not a screen-ROW count (log-update.js → ansi-escapes
 * `eraseLines`). When the terminal's width changes, the terminal first
 * re-flows the rows already on screen: every old frame row that was
 * exactly the old width (the box borders are full-width by construction)
 * now occupies TWO screen rows at the new width. Ink's line count is now
 * stale, so:
 *
 *   - width decrease: Ink's own `resized()` calls `log.clear()`, but that
 *     erases only the same stale count → the extra re-flowed rows survive
 *     every render (Ink's inline comment admits the intent — "prevent
 *     duplicate overlapping re-renders" — but the erase misses them);
 *   - width increase: Ink only clears on `currentWidth < last`, so it
 *     just writes the new frame over re-flowed leftovers.
 *
 * Either way each render stacks fragments of earlier frames behind the
 * live one — the stacked logo copies / stray border corners in the bug
 * report. This is an upstream Ink 7.1.1 limitation, so we fix it at the
 * app level instead of patching node_modules (a reinstall would revert
 * that).
 *
 * The guard MUST be installed BEFORE `render()` — EventEmitter fires
 * listeners in registration order, so this handler then runs before Ink's
 * own `resized` listener and can pre-empt the stale-count erase:
 *
 *   1. `ESC[2J ESC[H` blanks the viewport (all re-flowed fragments) and
 *      homes the cursor;
 *   2. `log.reset()` + `lastOutput = ''` make Ink forget the pre-resize
 *      frame, so its ensuing re-render emits `eraseLines(0)` (a no-op)
 *      and writes the full frame from (0,0) into the clean screen.
 *
 * Height-only resizes don't re-flow rows, so they're left to Ink (avoids
 * flicker while dragging a window edge vertically).
 */

/** The slice of Ink's render() instance this guard needs (all public fields). */
export interface InkInstanceLike {
  log?: { reset?: () => void }
  lastOutput?: string
  lastOutputToRender?: string
  lastOutputHeight?: number
  /**
   * Non-interactive renders (piped stdin) get no resize listener and no
   * re-render from Ink — blanking there would leave a bare screen with
   * nothing scheduled to repaint it, so the guard must stand down.
   */
  interactive?: boolean
  /** Set once teardown starts; a repaint will never come after this. */
  isUnmounted?: boolean
  isUnmounting?: boolean
}

export interface ResizeRedrawGuard {
  /** Bind the instance returned by Ink's render(). Idempotent. */
  attach(instance: InkInstanceLike): void
}

export interface ResizeGuardStdout {
  columns?: number
  on(event: "resize", listener: () => void): unknown
  write(chunk: string): unknown
}

export function createResizeRedrawGuard(stdout: ResizeGuardStdout): ResizeRedrawGuard {
  let instance: InkInstanceLike | undefined
  let lastColumns = stdout.columns

  stdout.on("resize", () => {
    const columns = stdout.columns
    // Rows-only change → no re-flow → let Ink handle it (no flicker).
    // columns can be 0/undefined while the console is being reattached;
    // skip those and treat them as "unchanged" so a later real change
    // still compares against the last usable width.
    if (!columns || columns === lastColumns) return
    lastColumns = columns

    // Nothing is on screen before render() completes — blanking there
    // would leave a bare screen with no redraw scheduled. Same for
    // non-interactive instances: Ink doesn't listen for resize there and
    // won't repaint what we just erased. After unmount Ink never renders
    // again either (its own listener is already detached), so blanking
    // would just wipe the final frame.
    if (!instance || instance.interactive === false) return
    if (instance.isUnmounted || instance.isUnmounting) return

    // 1. Blank viewport + home cursor: erases every re-flowed leftover
    //    at the old width. (2J = display only; scrollback above the app
    //    is left alone on purpose.)
    stdout.write("\u001B[2J\u001B[H")

    // 2. Forget the pre-resize frame so Ink's next render can't erase a
    //    stale line count from a stale cursor position.
    instance.log?.reset?.()
    instance.lastOutput = ""
    instance.lastOutputToRender = ""
    instance.lastOutputHeight = 0
  })

  return {
    attach(next) {
      instance = next
    },
  }
}
