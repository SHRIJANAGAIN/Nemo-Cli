/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * OSC 777 terminal activity notifications.
 *
 * The window title can only hold one bit of state — "busy" or "not busy" — so a
 * shell tab is either a spinner forever or gives up entirely. OSC 777 carries a
 * NAMED state plus a timestamp, which lets the prompt itself render it:
 *
 *     %{activity}
 *       set_terminal_title fish_prompt
 *     end
 *
 * The agent then publishes `idle` / `busy` / `retry` / `waiting` / `error` /
 * `done`, and the tab says what is actually happening instead of just pulsing.
 *
 * Emitting it unconditionally is wrong on two counts: terminals that do not
 * understand the sequence may print it literally, and it leaks into pipes and
 * log files. So this is opt-in through an environment flag, mirrors the exit
 * path, and heart-beats so a shell that only samples on prompt redraw still
 * sees a live value.
 */

/** The states a shell can usefully render. */
export type ActivityState = "idle" | "busy" | "retry" | "waiting" | "error" | "done"

/** Every state this module may emit, in the order a turn moves through them. */
export const ACTIVITY_STATES: readonly ActivityState[] = ["idle", "busy", "retry", "waiting", "error", "done"]

/**
 * Build the OSC 777 payload.
 *
 * ST (`\x1b\\`) is the terminator rather than BEL: BEL is ambiguous inside a
 * shell prompt that may itself be mid-escape, and the timestamp is what lets a
 * prompt discard a stale value.
 */
export function activitySequence(state: ActivityState, timestamp: number): string {
  return `\x1b]777;kilo;activity;1;${state};${Math.floor(timestamp)}\x1b\\`
}

/**
 * Off unless the shell has been told it wants this.
 *
 * Read at call time rather than captured at import: the variable is normally set
 * inside the user's shell profile, which is sourced after this module loads.
 */
export function activityEnabled(): boolean {
  return process.env.TRAYAMBAK_TERMINAL_ACTIVITY === "1"
}

/** Publish a state. A no-op when disabled, so call sites stay unconditional. */
export function publishActivity(state: ActivityState, timestamp: number = Date.now()): void {
  if (!activityEnabled()) return
  try {
    process.stdout.write(activitySequence(state, timestamp))
  } catch {
    /* a broken pipe must never break the agent */
  }
}

/** Return to `idle` so a closed tab is not left claiming to be busy. */
export function clearActivity(timestamp: number = Date.now()): void {
  publishActivity("idle", timestamp)
}

/**
 * Periodic keep-alive.
 *
 * Shells that only re-render on prompt redraw would otherwise keep showing the
 * state from whenever the agent last spoke. Returns a stop function; the
 * interval is UNREFIED so it never holds the process open on its own.
 */
export function startActivityHeartbeat(intervalMs: number = 5_000, state: ActivityState = "busy"): () => void {
  if (!activityEnabled()) return () => {}
  publishActivity(state)
  const timer = setInterval(() => publishActivity(state), Math.max(1_000, intervalMs))
  timer.unref?.()
  return () => clearInterval(timer)
}
