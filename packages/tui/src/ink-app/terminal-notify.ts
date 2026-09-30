/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * SKT AI LABS's terminal activity port: keep the terminal title in sync with agent
 * state (OSC 0), ring the bell, and OSD-notify when attention is needed
 * (approval / input / error / background task finished). Writes are
 * synchronous (fs.writeSync) so they can't interleave with Ink's frame
 * writes mid-sequence, throttled so a busy loop can't spam the terminal.
 *
 *   TRAYAMBAK_NO_NOTIFY=1  disables everything.
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

/** Pure title builder — returns the OSC 0 payload text (ASCII only). */
export function buildTerminalTitle(parts: TerminalTitleParts, appName = "trayambak CLI"): string {
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
  if (process.env.TRAYAMBAK_NO_NOTIFY === "1") return
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
    osc9Notify("trayambak CLI", parts.detail) // gated internally (TERM_PROGRAM + tmux)
    lastOsc9At = now
  }
}
