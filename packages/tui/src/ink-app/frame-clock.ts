/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Portions derived from OpenAI Codex CLI (codex-rs), Copyright 2025 OpenAI,
 * licensed under the Apache License, Version 2.0. See THIRD_PARTY_NOTICES.md.
 */

/**
 * One timer for every animation in the TUI.
 *
 * Ported in behaviour from codex-rs `tui/frame_requester.rs` +
 * `tui/frame_rate_limiter.rs`: Codex keeps a single `FrameScheduler` that
 * coalesces many widget requests into one draw notification, clamped to 120 FPS,
 * and stops notifying entirely when nothing is pending. Nemo used to do the
 * opposite — `Spinner` ran an 80ms `setInterval`, `useBorderPulse` a 160ms one,
 * `ToolUseLoader` a 600ms one, and every live tool box instantiated its own. A
 * screen with a dozen running calls meant a dozen independent timers, each
 * forcing its own partial re-render at an unrelated phase, so ink wrote several
 * times per frame instead of once.
 *
 * The React translation of "coalesce into one draw" is `useSyncExternalStore`
 * over a derived tick: the store advances ONE global frame counter on ONE
 * interval, each widget is registered with a divisor for its own cadence, and a
 * widget is only notified on the ticks where its derived value actually
 * changes. So a spinner (80ms) and a slow blink (600ms) share the timer and the
 * same repaint commit, and the blink is not re-rendered 7 times for nothing.
 */

/** Fastest the clock may tick. 8.3334ms is the 120 FPS ceiling Codex clamps to
 *  (`MIN_FRAME_INTERVAL` in frame_rate_limiter.rs): a terminal cannot show more
 *  and every extra tick is pure CPU plus scrollback churn. */
export const MIN_FRAME_INTERVAL_MS = 8.3334

/** Master cadence. 20ms divides cleanly into every interval the TUI uses —
 *  80ms spinner (4), 160ms border chase (8), 600ms blink (30) — so each widget's
 *  divisor is exact rather than approximately rounded, which is what keeps two
 *  spinners on the same screen in phase instead of drifting apart. */
export const DEFAULT_MASTER_INTERVAL_MS = 20

const masterMs = DEFAULT_MASTER_INTERVAL_MS
let timer: ReturnType<typeof setInterval> | null = null
let frame = 0
let nextId = 1
/** Origin for the elapsed-time tick derivation, re-anchored whenever the master
 *  timer starts. Deriving from elapsed time rather than from the firing count is
 *  what keeps a busy screen honest: `setInterval` never runs on time under load
 *  (the event loop is blocked by model streaming), and a firing-count tick LOST
 *  every starved beat, so animation silently slowed down and drift out of phase
 *  between two widgets was unfixable. Elapsed-time ticks catch up. */
let epochMs = Date.now()

interface Registration {
  divisor: number
  onTick: () => void
  /** The derived tick this widget was last notified at, so a starved master
   *  beat can notify a slow widget once with the true value instead of once per
   *  firing with a stale one. */
  lastTick: number
}

const registrations = new Map<number, Registration>()

/** Frames per master tick a widget at `intervalMs` advances by. */
export function divisorFor(intervalMs: number): number {
  const step = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : MIN_FRAME_INTERVAL_MS
  return Math.max(1, Math.round(Math.max(step, MIN_FRAME_INTERVAL_MS) / masterMs))
}

/** Whole master frames since `epochMs`; never negative, because a stepped or
 *  rewound test clock must not be able to move an animation backwards. */
function elapsedFrames(): number {
  return Math.max(0, Math.floor((Date.now() - epochMs) / masterMs))
}

function emit(): void {
  frame += 1
  const elapsed = elapsedFrames()
  // Iterating a live Map is safe here: an onTick can unmount a widget
  // synchronously, so the map may shrink mid-loop, but a deleted entry simply
  // stops being visited rather than corrupting the walk.
  for (const reg of registrations.values()) {
    const tick = Math.floor(elapsed / reg.divisor)
    if (tick !== reg.lastTick) {
      reg.lastTick = tick
      reg.onTick()
    }
  }
}

/**
 * Register an animation cadence for the lifetime of one widget.
 *
 * Returns the unsubscribe, which callers MUST invoke (the hook does in cleanup).
 * Registration is reference-counted: when the last one goes away the interval is
 * cleared, so a screen with nothing running costs zero timers and zero repaints
 * — the idle-stop property that made Codex's scheduler worth copying.
 */
export function subscribeToClock(intervalMs: number, onTick: () => void): () => void {
  const id = nextId++
  const divisor = divisorFor(intervalMs)
  const starting = timer === null
  if (starting) {
    // Re-anchoring on the first subscription after a fully idle screen means the
    // widgets that arrive together all start their cadence at tick 0, in phase —
    // the property that made the shared clock worth building.
    epochMs = Date.now()
  }
  registrations.set(id, { divisor, onTick, lastTick: Math.floor(elapsedFrames() / divisor) })
  if (starting) {
    timer = setInterval(emit, masterMs)
    // Never hold the process open for an animation: a session that is otherwise
    // finished must be able to exit while a spinner is still mounted.
    timer.unref?.()
  }
  return () => {
    if (!registrations.delete(id)) return
    if (registrations.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

/** The global frame counter. */
export function clockFrame(): number {
  return frame
}

/** The derived tick for a cadence — the value a hook snapshot renders with. */
export function tickAt(intervalMs: number): number {
  return Math.floor(elapsedFrames() / divisorFor(intervalMs))
}

/** Whether the master timer is live. False means nothing is animating. */
export function clockIsRunning(): boolean {
  return timer !== null
}

/** Total registered cadences. Tests pin this to prove idle-stop and cleanup. */
export function clockRegistrationCount(): number {
  return registrations.size
}

/**
 * Test seam: drop all state so each case starts at frame 0 with no timer.
 * Production code must never call this — it orphans live widgets' unsubscribe
 * closures, so their next repaint would silently stop animating.
 */
export function resetFrameClockForTests(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
  registrations.clear()
  frame = 0
  nextId = 1
  // Re-anchored with the frame counter, so a case that starts at frame 0 also
  // starts at tick 0 instead of inheriting elapsed time from the real process.
  epochMs = Date.now()
}
