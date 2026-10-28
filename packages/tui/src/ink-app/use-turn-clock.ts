/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * How long the current turn has been WORKING.
 *
 * A turn's wall time and its work time are different numbers. A permission
 * prompt that sits unanswered for 90 seconds inflates the first and says
 * nothing about the second: the model was not thinking, the human was not at
 * the keyboard. Rendering wall time beside the word "Thinking…" therefore
 * charges the model for time it never spent — the same class of lie as a
 * spinner still turning on a dead socket.
 *
 * So the clock stops while the app waits on the user (permission overlay,
 * question, custom-answer prompt) and starts again when the answer lands. It
 * keeps running while a turn is parked on a dead network, because that wait IS
 * part of doing the work and the user should see it measured.
 *
 * Being a real quantity, the number is never gated by the motion policy: the
 * level that removes movement was never a request for stale data.
 */

import { useRef } from "react"

/** The whole turn's accounting, in epoch ms. */
export interface TurnClock {
  /** When the app started working; absent before a turn exists. */
  startedAt?: number
  /** ms of COMPLETED waits inside this turn. */
  pausedMs: number
  /** When the CURRENT wait on the user began, absent if none is open. Kept
   *  separate from `pausedMs` so a dialog that is still open is excluded NOW
   *  rather than only after it closes. */
  waitingSince?: number
}

/** What `advanceTurnClock` is asked each render. */
export interface TurnClockInput {
  /** A turn is in flight (including one parked on a dead socket). */
  active: boolean
  /** A modal owns the keyboard, so the model is not the thing being waited on. */
  waitingOnUser: boolean
  /** Injectable clock; the tests need to name the seconds. */
  now: number
}

const EMPTY: TurnClock = { pausedMs: 0 }

/**
 * One step of the state machine, kept pure so the arithmetic is testable
 * without React. The hook below is the only place it is stored.
 */
export function advanceTurnClock(state: TurnClock, input: TurnClockInput): TurnClock {
  if (!input.active) {
    // Turn over (or never started): the next one begins from zero, and a dialog
    // left open across the boundary must not leak its wait into it.
    return EMPTY
  }
  const startedAt = state.startedAt ?? input.now
  if (input.waitingOnUser) {
    // `??` and not `=`: the first render of a wait stamps it, every later
    // render keeps the original stamp.
    return { startedAt, pausedMs: state.pausedMs, waitingSince: state.waitingSince ?? input.now }
  }
  if (state.waitingSince === undefined) return { startedAt, pausedMs: state.pausedMs }
  return {
    startedAt,
    pausedMs: state.pausedMs + Math.max(0, input.now - state.waitingSince),
    waitingSince: undefined,
  }
}

/** Total time spent waiting on the user, open wait included. */
export function pausedMsOf(clock: TurnClock, now = Date.now()): number {
  if (clock.waitingSince === undefined) return clock.pausedMs
  return clock.pausedMs + Math.max(0, now - clock.waitingSince)
}

/** ms the turn has actually been working; 0 when nothing is running. */
export function turnElapsedMs(clock: TurnClock, now = Date.now()): number {
  if (clock.startedAt === undefined) return 0
  return Math.max(0, now - clock.startedAt - pausedMsOf(clock, now))
}

/**
 * The clock for the turn the app is running now.
 *
 * Refs, and all bookkeeping during render: every transition that can move these
 * numbers (`isLoading`, the pending dialogs) is already a state change in the
 * owner, so an effect would only lag the truth by a frame. A state-per-second
 * would re-render the whole app every second to change three characters, when
 * the widget that shows the clock already ticks itself.
 */
export function useTurnClock(active: boolean, waitingOnUser: boolean, now = Date.now()): TurnClock {
  const store = useRef<TurnClock>(EMPTY)
  store.current = advanceTurnClock(store.current, { active, waitingOnUser, now })
  return store.current
}
