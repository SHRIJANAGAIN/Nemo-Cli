/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * React bindings for the shared animation clock.
 *
 * The whole point is that no widget owns a timer any more. Each hook below
 * subscribes to `frame-clock.ts` with its own cadence and reads a DERIVED tick
 * through `useSyncExternalStore`, so React only commits for a widget when that
 * widget's tick actually moved. Twenty live tool boxes therefore repaint in one
 * shared commit instead of twenty interleaved partial writes.
 *
 * Every decorative hook honours the motion level: `off` means do not subscribe
 * at all (resting frame, zero timers) and `reduced` keeps colour changes but
 * slows the tick and stops anything travelling. `useTicker` is the deliberate
 * exception — it drives readouts that display a real quantity, which a motion
 * preference must never freeze.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { subscribeToClock, tickAt } from "./frame-clock.js"
import { lerp, motionIntervalMs, motionTravels, progressAt, type EasingName, type MotionLevel } from "./animations.js"
import { getMotionLevel, motionVersion, subscribeMotion } from "./motion-store.js"

/** Number interpolation cadence: 25fps is plenty for a value, and it is the
 *  slowest thing on the clock, so it never forces spinners to redraw. */
const INTERPOLATE_INTERVAL_MS = 40

/** Default travel time for a count-up. Long enough to read, short enough that a
 *  fast token stream never queues a stale animation behind the live number. */
const DEFAULT_COUNT_MS = 450

/** The active motion level, reactive: a `/motion` switch repaints immediately. */
export function useMotionLevel(): MotionLevel {
  useSyncExternalStore(subscribeMotion, motionVersion)
  return getMotionLevel()
}

/**
 * The subscription itself, at an already-resolved cadence.
 *
 * `step` is the interval in ms, or 0 for "not running" — which subscribes to
 * nothing and pins the tick at 0 so the store cannot schedule a render. Idle
 * screens therefore have no animation timer at all, the idle-stop property
 * copied from Codex's frame scheduler.
 */
function useClockTick(step: number): number {
  const subscribe = useCallback(
    (onStoreChange: () => void) => (step > 0 ? subscribeToClock(step, onStoreChange) : () => undefined),
    [step],
  )
  const read = useCallback(() => (step > 0 ? tickAt(step) : 0), [step])
  return useSyncExternalStore(subscribe, read)
}

/** A decoration tick advancing every `intervalMs`, slowed or stopped by motion. */
export function useAnimationClock(intervalMs: number, active: boolean = true): number {
  const level = useMotionLevel()
  return useClockTick(active ? motionIntervalMs(intervalMs, level) : 0)
}

/**
 * A tick advancing every `intervalMs`, NOT slowed or stopped by the motion level.
 *
 * The motion policy is about decoration: `off` means a shimmer, a sweep or a
 * marquee installs no timer. It was never meant to freeze information. An
 * elapsed-seconds readout gated by `off` silently stops counting, so the user
 * reads "3s" above a call that has been running for two minutes — worse than no
 * number at all. Anything that displays a REAL quantity (wall time, counts)
 * takes its cadence from here; anything that only looks pretty stays on
 * `useAnimationClock`.
 *
 * `active` still gates the subscription, so an idle surface costs zero timers.
 */
export function useTicker(intervalMs: number, active: boolean = true): number {
  return useClockTick(active ? intervalMs : 0)
}

/** Whether travelling motion (sweep, chase, marquee) is allowed right now. */
export function useTravel(active: boolean): boolean {
  // `useMotionLevel` must run on EVERY render: putting it behind `active &&`
  // made the hook count change when a box went idle/live, and React then
  // mis-aligned the surrounding hooks ("change in the order of Hooks called
  // by NemoApp", crash in useSyncExternalStore).
  const level = useMotionLevel()
  return active && motionTravels(level)
}

/**
 * Ease `target` toward its new value over `durationMs`.
 *
 * A fresh segment always starts from the DISPLAYED value, not the previous
 * target: token counts arrive faster than a 450ms curve completes, and starting
 * from the stale target made the number leap backwards on every update.
 * `off` returns the target untouched, so a CI capture reads the true count.
 */
export function useCountUp(
  target: number,
  options: { durationMs?: number; easing?: EasingName; precision?: number } = {},
): number {
  const level = useMotionLevel()
  const durationMs = options.durationMs ?? DEFAULT_COUNT_MS
  const easing = options.easing ?? "easeOutCubic"
  const precision = options.precision ?? 0
  const animate = level !== "off" && durationMs > 0 && Number.isFinite(target)

  const [shown, setShown] = useState(target)
  const shownRef = useRef(target)
  shownRef.current = shown
  const segmentRef = useRef<{ from: number; to: number; startedAt: number } | null>(null)
  const [running, setRunning] = useState(/*initial*/ false)

  useEffect(() => {
    if (!animate) {
      segmentRef.current = null
      setRunning(/*initial*/ false)
      setShown(target)
      return
    }
    const seg = segmentRef.current
    if (seg && seg.to === target) return
    if (seg === null && shownRef.current === target) return
    segmentRef.current = { from: shownRef.current, to: target, startedAt: Date.now() }
    setRunning(/*initial*/ true)
  }, [target, animate])

  const tick = useAnimationClock(INTERPOLATE_INTERVAL_MS, running)
  useEffect(() => {
    const seg = segmentRef.current
    if (!seg) {
      if (running) setRunning(/*initial*/ false)
      return
    }
    const p = progressAt(Date.now() - seg.startedAt, durationMs, easing)
    const next = roundTo(lerp(seg.from, seg.to, p), precision)
    if (p >= 1) {
      segmentRef.current = null
      setRunning(/*initial*/ false)
    }
    // setState with the same number bails out, so a 40ms tick that lands on the
    // same integer (a slow count, a rounded display) costs no render at all.
    setShown(next)
  }, [tick, running, durationMs, easing, precision])

  return shown
}

function roundTo(value: number, precision: number): number {
  if (!(precision > 0)) return Math.round(value)
  const scale = 10 ** precision
  return Math.round(value * scale) / scale
}

/** Milliseconds since `active` became true, 0 while inactive. */
export function useElapsed(active: boolean, intervalMs = 1000): number {
  const startRef = useRef<number | null>(null)
  if (active && startRef.current === null) startRef.current = Date.now()
  if (!active && startRef.current !== null) startRef.current = null
  // `useTicker`, not `useAnimationClock`: this value is a wall time, so the
  // motion level may slow nothing about it — `off` would freeze the number.
  const tick = useTicker(intervalMs, active)
  // `tick` is what schedules the recompute; reading it is otherwise unused.
  void tick
  return startRef.current === null ? 0 : Math.max(0, Date.now() - startRef.current)
}

export default useAnimationClock
