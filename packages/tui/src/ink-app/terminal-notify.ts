/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Shrijan's terminal activity port: keep the terminal title in sync with agent
 * state (OSC 0), ring the bell, and OSD-notify when attention is needed
 * (approval / input / error / background task finished). Writes are
 * synchronous (fs.writeSync) so they can't interleave with Ink's frame
 * writes mid-sequence, throttled so a busy loop can't spam the terminal.
 *
 *   NEMO_NO_NOTIFY=1  disables everything.
 *   Non-TTY stdout         disables everything.
 */

import { writeSync } from "fs"
import { osc9Notify } from "../notifications.js"

export type TerminalActivity = "idle" | "working" | "approval" | "input" | "error" | "task-done"

export interface TerminalTitleParts {
  activity: TerminalActivity
  backgroundCount?: number
}

const ACTIVITY_MARKS: Record<TerminalActivity, string> = {
  // ASCII-only: the ●/✓/⚠/❓/✖ marks rendered as mojibake ("rÃ¼a", "GÇo")
  // on non-UTF8 consoles (conhost raster fonts / legacy codepage tabs).
  idle: "",
  working: "* ",
  approval: "! ",
  input: "? ",
  error: "! ",
  "task-done": "",
}

const ACTIVITY_SUFFIX: Record<TerminalActivity, string> = {
  idle: "",
  working: "working",
  approval: "approval needed",
  input: "input needed",
  error: "error",
  "task-done": "task finished",
}

/**
 * Product name as it appears in the tab/window title. The terminal tab
 * otherwise shows the shell's cwd (a bare folder name like "engli"), which
 * tells the user nothing about what is running.
 */
export const APP_TITLE_NAME = "Nemo"

/** Pure title builder — returns the OSC 0 payload text (ASCII only). */
export function buildTerminalTitle(parts: TerminalTitleParts, appName = APP_TITLE_NAME): string {
  const bg = parts.backgroundCount && parts.backgroundCount > 0 ? ` (${parts.backgroundCount} background)` : ""
  const suffix = ACTIVITY_SUFFIX[parts.activity]
  return `${ACTIVITY_MARKS[parts.activity]}${appName}${bg}${suffix ? ` - ${suffix}` : ""}`
}

/** Activities a user watching another window should be told about. */
const ATTENTION_ACTIVITIES: ReadonlySet<TerminalActivity> = new Set(["approval", "input", "error", "task-done"])

let lastTitle: string | null = null
let lastBellAt = 0
let lastOsc9At = 0

/**
 * Write the title (on change), ring the bell, and OSD-notify — all throttled
 * and best-effort: the terminal UI must never break over a notification.
 * `detail` is the OSD body (approval/error text); it never enters the title.
 */
export function notifyTerminalActivity(parts: TerminalTitleParts & { detail?: string }): void {
  if (notificationsDisabled()) return
  if (!process.stdout.isTTY) return

  const title = buildTerminalTitle(parts)
  if (title !== lastTitle) {
    try {
      writeSync(1, `\x1b]0;${title}\x07`)
    } catch {
      /* ignore — a title write must never throw into the render loop */
    }
    lastTitle = title
  }

  if (!ATTENTION_ACTIVITIES.has(parts.activity)) return

  const now = Date.now()
  if (now - lastBellAt > 2000) {
    try {
      writeSync(1, "\x07")
    } catch {
      /* ignore */
    }
    lastBellAt = now
  }
  if (parts.detail && now - lastOsc9At > 5000) {
    osc9Notify(APP_TITLE_NAME, parts.detail) // gated internally (TERM_PROGRAM + tmux)
    lastOsc9At = now
  }
}

/**
 * Live title animation while the agent is working: the tab shows a spinner
 * frame so a user with several terminals can see at a glance which one is
 * busy, instead of six tabs all reading "engli".
 *
 * ASCII frames only, for the same reason the activity marks are: the braille
 * spinner renders as mojibake on non-UTF8 conhost tabs.
 */
const SPINNER_FRAMES = ["|", "/", "-", "\\"] as const
const SPINNER_INTERVAL_MS = 120

let spinnerTimer: ReturnType<typeof setInterval> | null = null
let spinnerFrame = 0
/** Opaque state the caller threads through start/stop (e.g. a ref value). */
export interface TitleAnimationState {
  /** Background subagent count folded into the animated title. */
  backgroundCount?: number
  /** Free-text suffix describing the current phase (never prompt content). */
  phase?: string
}

/** Pure animated-title builder, so the frame sequence is unit-testable. */
export function buildAnimatedTitle(frame: string, state: TitleAnimationState = {}, appName = APP_TITLE_NAME): string {
  const bg = state.backgroundCount && state.backgroundCount > 0 ? ` (${state.backgroundCount} bg)` : ""
  const phase = state.phase ? ` ${state.phase}` : ""
  return `${frame} ${appName}${bg}${phase}`
}

/**
 * Terminal-effect kill switch.
 *
 * Read directly rather than through env_filter: getSafeEnv() is a *child
 * process* allowlist (it drops non-essentials and stamps the sandbox
 * marker), so routing a local UI preference through it would both be the
 * wrong tool and silently discard the variable. A documented NEMO_*
 * preference is not a secret-handling concern.
 */
function notificationsDisabled(): boolean {
  return process.env.NEMO_NO_NOTIFY === "1"
}

/** Synchronous by default; replaceable only by the byte-level tests. */
let titleWriter: ((fd: number, text: string) => void) | null = null

function writeTitle(title: string): void {
  if (notificationsDisabled()) return
  if (!process.stdout.isTTY) return
  if (title === lastTitle) return
  try {
    // Synchronous (fs.writeSync): a queued stdout write can land mid-frame and
    // corrupt Ink's rendering.
    ;(titleWriter ?? writeSync)(1, `\x1b]0;${title}\x07`)
    lastTitle = title
  } catch {
    /* a title write must never break the UI */
  }
}

/** Set the tab/window title once, without touching activity state. */
export function setTerminalTitle(title: string): void {
  writeTitle(title)
}

/**
 * Injection seam for the byte-level tests.
 *
 * Production always writes with the synchronous `fs.writeSync` (a queued
 * stdout write can land mid-frame and corrupt Ink's rendering), and ESM
 * namespace objects are immutable so a test cannot spy on it. Passing the
 * writer explicitly keeps the real default in production while letting the
 * tests observe the exact bytes. Deliberately not exported from the barrel —
 * this is for `terminal-title-bytes.test.ts` only.
 */
export function setTitleWriterForTests(writer: ((fd: number, text: string) => void) | null): void {
  titleWriter = writer
}

/**
 * Start (or restart) the spinner. Safe to call on every state change — the
 * previous timer is always cleared first, so a re-render cannot leak intervals.
 */
export function startTitleAnimation(state: TitleAnimationState = {}): void {
  stopTitleAnimation()
  spinnerFrame = 0
  writeTitle(buildAnimatedTitle(SPINNER_FRAMES[0], state))
  spinnerTimer = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length
    writeTitle(buildAnimatedTitle(SPINNER_FRAMES[spinnerFrame], state))
  }, SPINNER_INTERVAL_MS)
  // Never hold the process open for a cosmetic animation.
  spinnerTimer.unref?.()
}

/** Stop the spinner and leave the title on its final static form. */
export function stopTitleAnimation(finalTitle?: string): void {
  if (spinnerTimer) {
    clearInterval(spinnerTimer)
    spinnerTimer = null
  }
  if (finalTitle !== undefined) writeTitle(finalTitle)
}

/** True while an animation timer is armed (used by tests/UI). */
export function isTitleAnimating(): boolean {
  return spinnerTimer !== null
}
