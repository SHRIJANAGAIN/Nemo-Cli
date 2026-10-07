/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import fs from "node:fs"

import { requestSettleReprint, syncWindowSizeCache } from "./app-bootstrap.js"

/**
 * Resize guard for Ink apps: blank the viewport and reset Ink's line
 * bookkeeping so the post-resize redraw starts clean. Fires on a width change
 * and on a height SHRINK (the boot frame leak — see the listener body).
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
 * Height-only SHRINKS re-anchor too, even though they don't re-flow rows:
 * the painted frame is `rows - 1` tall, so a shorter window leaves it taller
 * than the window itself — every repaint then writes below the window's last
 * row, the console scrolls a row per repaint, and the frames stack up in
 * scrollback (the boot leak: the same Welcome screen copied dozens of times).
 * Growth is left to Ink: the frame keeps its top row and just grows downward
 * inside the taller window, with no re-flow and no scroll.
 *
 * Deliberately NOT covered: a resize event whose geometry reads 0/undefined
 * (console mid-reattach, mid-drag, or — on Windows — the event Node emits
 * when the BUFFER scrolls). Anchoring there built a feedback loop (anchor →
 * full-frame write → last row scrolls → "resize" → anchor, one 2J+H per
 * repaint forever), so those events are skipped and the last known good
 * geometry is kept. A settle anchor still fires after every REAL change.
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
  rows?: number
  on(event: "resize", listener: () => void): unknown
  /** Optional: test fakes predate it. Real streams always carry emit. */
  emit?(event: "resize"): unknown
  write(chunk: string): unknown
}

/** Debounce for the post-resize settle anchor (see the listener). Long enough
 *  that a window drag's event burst collapses into one extra repaint, short
 *  enough that the user sees the clean frame before the next idle tick. */
const SETTLE_ANCHOR_MS = 150

/** Geometry poll cadence. Only fires work when the size actually changed, so
 *  this is one cheap syscall per interval, not a repaint. Faster than the
 *  500ms idle repaint so a missed event is caught before the next tick can
 *  paint stale. */
const SIZE_POLL_MS = 250

/** Hard floor between two screen blanks. A window drag fires resize events far
 *  faster than a human can read; without this the screen strobes. */
const ANCHOR_MIN_INTERVAL_MS = 250

/** Home the cursor without erasing anything. Cheap and strobe-free, unlike a
 *  blank: the next paint simply overwrites rows in place. */
const HOME = "[H"

/**
 * Resize-event forensics, OFF unless asked. With TRAYAMBAK_RESIZE_DEBUG=1 the
 * guard appends one line per resize event (timestamp, reported geometry, last
 * known geometry, decision) to TRAYAMBAK_RESIZE_LOG, or ./trayambak-resize.log
 * when that is unset. This is the instrument that finally separates "the app
 * never saw the resize" from "the app saw it and painted wrong" — the byte
 * trace alone cannot show the events. Never throws; never runs otherwise.
 */
function traceResizeEvent(line: string): void {
  try {
    if (process.env.TRAYAMBAK_RESIZE_DEBUG !== "1") return
    const file = process.env.TRAYAMBAK_RESIZE_LOG ?? "trayambak-resize.log"
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* diagnostics must never break the UI */
  }
}

export function createResizeRedrawGuard(stdout: ResizeGuardStdout): ResizeRedrawGuard {
  let instance: InkInstanceLike | undefined
  let lastColumns = stdout.columns
  let lastRows = stdout.rows
  let lastAnchorAt = Number.NEGATIVE_INFINITY
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  // Latched by any shrink event, consumed by the settle handler. Scrollback
  // damage (reflow splits, one over-tall paint) is terminal-side and no
  // viewport blank reaches it — only clear+reprint does.
  let damageSinceSettle = false
  // Boot line: identifies the build (poll present?) and the launch geometry
  // every later line is measured against. Without this, a log with two lines
  // cannot tell "delivery died after birth" from "nothing ever happened".
  const pollCapable =
    typeof (stdout as unknown as { getWindowSize?: unknown }).getWindowSize === "function"
  traceResizeEvent(`guard init cols=${stdout.columns} rows=${stdout.rows} poll=${pollCapable ? "on" : "off"}`)

  /** Blank the viewport, home the cursor, and make Ink forget the pre-resize
   *  frame so its next render writes one whole frame from (0,0). */
  const anchor = (): void => {
    // Nothing is on screen before render() completes — blanking there leaves a
    // bare screen with no redraw scheduled. Same for non-interactive
    // instances (Ink listens for resize only when interactive) and after
    // unmount (no render ever comes, so blanking would wipe the final frame).
    if (!instance || instance.interactive === false) return
    if (instance.isUnmounted || instance.isUnmounting) return
    // 2J = display only; scrollback above the app is left alone on purpose.
    stdout.write("[2J[H")
    forgetFrame()
  }

  /**
   * Home the cursor and make Ink forget the pre-resize frame, WITHOUT
   * blanking. This is what a rate-limited resize event gets instead of
   * nothing.
   *
   * Why not nothing: a window drag fires many resize events inside one
   * ANCHOR_MIN_INTERVAL_MS, and every skipped event left Ink repainting from
   * the bottom cursor with a stale line count. Past a shrink that scrolls —
   * each skipped repaint pushed rows into scrollback, so one drag stacked a
   * whole cloned frame behind the live one (reported live, twice, as clean
   * full-frame copies after every drag). Re-homing turns those repaints into
   * top-anchored overwrites: same rows, no scroll, no scrollback damage. The
   * settle anchor still blanks once at the end, so any transient residue from
   * re-flowed rows is wiped and only the live frame remains.
   */
  const rehome = (): void => {
    if (!instance || instance.interactive === false) return
    if (instance.isUnmounted || instance.isUnmounting) return
    stdout.write(HOME)
    forgetFrame()
  }

  /** Drop Ink's memory of the pre-resize frame so the next render is a full
   *  overwrite from wherever the cursor now sits, never a stale-count erase. */
  const forgetFrame = (): void => {
    instance?.log?.reset?.()
    if (instance) {
      instance.lastOutput = ""
      instance.lastOutputToRender = ""
      instance.lastOutputHeight = 0
    }
  }

  stdout.on("resize", () => {
    const columns = stdout.columns
    const rows = stdout.rows
    // Only a REAL geometry change may blank the screen. On Windows Node also
    // emits "resize" when the BUFFER scrolls (the console window rectangle
    // moved inside the buffer): anchoring on that is a feedback loop — anchor
    // → full-frame write → last row scrolls → "resize" → anchor, once per
    // repaint, leaving a residue row below the viewport every pass, and that
    // residue is what the user saw as frame clones (measured: one 2J+H per
    // 500ms tick, forever, right after a resize). A geometry-less event (0 /
    // undefined during a reattach or a drag) is skipped for the same reason.
    if (!columns || !rows) {
      traceResizeEvent(
        `resize cols=${columns} rows=${rows} last=${lastColumns}x${lastRows} SKIP geometry-unknown`,
      )
      return
    }
    const widthChanged = columns !== lastColumns
    // A SHORTER window is the boot frame leak. The painted frame is
    // `rows - 1` tall, so shrinking rows leaves it TALLER than the window:
    // every repaint's erase+rewrite then runs past the window's last row, the
    // console scrolls one row per repaint, and the frame marches down until
    // the frames are stacked in scrollback (reported live: the same Welcome
    // screen copy-pasted dozens of times, only ever right after the terminal
    // came up — that start-up settle is exactly one of these shrinks).
    // scripts/diag-conhost-replay.ps1 measures it: a frame one row taller
    // than the window pushes the buffer +1 row per repaint, an in-budget
    // frame stays flat.
    const heightShrank = typeof lastRows === "number" && rows < lastRows
    // Snapshot for traces BEFORE any baseline moves below: several branches
    // update lastColumns/lastRows first, so logging them there prints the new
    // geometry as if it were the old (a real confusion seen live: last==cols
    // next to widthChanged=true). Traces below use prev*, never last*.
    const prevColumns = lastColumns
    const prevRows = lastRows
    // Pure growth (or a same-size echo): the frame keeps its top row and grows
    // downward inside the taller/wider window — no re-flow splits, no scroll —
    // so no blank (a vertical drag would strobe on every event otherwise).
    // But the baselines MUST still move: without this a growth leaves stale
    // geometry behind, and the shrink back to the original size then reads as
    // "unchanged" — no blank, and the outlives-window leak it was built to
    // stop walks straight through (caught by smoke-resize-guard 3b).
    if (!widthChanged && !heightShrank) {
      traceResizeEvent(
        `resize cols=${columns} rows=${rows} last=${lastColumns}x${lastRows} SKIP unchanged-geometry`,
      )
      lastColumns = columns
      lastRows = rows
      return
    }
    // A narrower window re-flows the rows already on screen: every full-width
    // row (borders, padded art, fills — full-width by construction) splits in
    // two, the grid grows past the window bottom, and the surplus scrolls
    // into scrollback. That scroll IS the clone: intact rows, terminal-side,
    // before the app paints a single byte. The only preemption is a blank
    // that lands first, so a width shrink ALWAYS blanks — never throttled.
    // Strobe cost is bounded by the drag itself (each blank is immediately
    // repainted at the new size), and permanent scrollback pollution is worse
    // than transient flicker; the reporter chose clean on this trade twice.
    const widthShrank = typeof lastColumns === "number" && columns < lastColumns
    // Baselines move on every genuine change, blanked or not: the next event
    // must compare against the latest geometry, not the last blank.
    lastColumns = columns
    lastRows = rows
    // Damage latch for the settle below: any shrink (width re-flows rows into
    // scrollback terminal-side; height can outlive one stale paint) means the
    // scrollback may hold clone rows no viewport blank can reach. The settle
    // then clears scrollback AND reprints the transcript from item 0 (pi's
    // fullRender(true), ported: 2J+H+3J + full reprint), so history survives
    // clean instead of cloned. Growth alone never sets it.
    if (widthShrank || heightShrank) damageSinceSettle = true
    const armSettle = (): void => {
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = setTimeout(() => {
        settleTimer = undefined
        anchor()
        // Viewport is blank and the cursor home; now rebuild scrollback iff a
        // shrink may have soiled it. 3J first (scrollback gone), THEN the
        // reprint request — App bumps staticEpoch, Ink remounts Static and
        // prints history from 0, dynamic frame follows. Order is load-bearing:
        // paint before 3J would be wiped, 3J with no reprint would eat history.
        // Same usability guards as anchor (no live owner → neither write).
        if (damageSinceSettle) {
          damageSinceSettle = false
          if (instance && instance.interactive !== false && !instance.isUnmounted && !instance.isUnmounting) {
            traceResizeEvent("settle: scrollback clear + full transcript reprint")
            stdout.write("[3J")
            requestSettleReprint()
          }
        }
      }, SETTLE_ANCHOR_MS)
      settleTimer.unref?.()
    }
    if (widthShrank) {
      traceResizeEvent(`resize cols=${columns} rows=${rows} SHRINK-blank (never throttled)`)
      lastAnchorAt = Date.now()
      anchor()
      armSettle()
      return
    }
    // Width GREW (nothing splits on growth, line counts stay valid) or only
    // the height shrank (no re-flow from height alone, and live-fit paints
    // already fit): the full blank stays throttled for strobe protection, and
    // a skipped event still re-homes (see rehome) so its repaint overwrites
    // from the top instead of scrolling clones into scrollback.
    if (Date.now() - lastAnchorAt < ANCHOR_MIN_INTERVAL_MS) {
      traceResizeEvent(
        `resize cols=${columns} rows=${rows} last=${prevColumns}x${prevRows} REHOME rate-limit`,
      )
      rehome()
      armSettle()
      return
    }
    traceResizeEvent(
      `resize cols=${columns} rows=${rows} last=${prevColumns}x${prevRows} ANCHOR widthChanged=${widthChanged} heightShrank=${heightShrank}`,
    )
    lastAnchorAt = Date.now()
    lastColumns = columns
    lastRows = rows

    anchor()
    // Windows Terminal re-flows its buffer AFTER the app has been told about
    // the new size, so one anchor can land before the re-flow and leave the
    // moved rows behind — that residue is what the clones are made of. One
    // more anchor once the resize settles wipes it, and the 500ms idle repaint
    // puts a clean frame straight back. Debounced, so a continuous drag
    // re-arms instead of strobing.
    armSettle()

  })

  // Safety net for consoles where 'resize' never fires (verified live: zero
  // events across whole-window drags, columns/rows frozen at launch size).
  // Refreshes Node's cache from the syscall; on a real change it emits a
  // synthetic resize so Ink, the guard listener above, and React state all
  // follow the exact same path as a real event. Silent where unsupported (no
  // getWindowSize: pipes, tests) or unchanged — one cheap syscall per tick,
  // never a repaint by itself. Unref'd so it never holds the process open;
  // same stand-down discipline as anchor (no live owner → no work).
  const pollTimer = setInterval(() => {
    if (!instance || instance.interactive === false) return
    if (instance.isUnmounted || instance.isUnmounting) return
    if (syncWindowSizeCache(stdout)) stdout.emit?.("resize")
  }, SIZE_POLL_MS)
  pollTimer.unref?.()

  return {
    attach(next) {
      instance = next
    },
  }
}
