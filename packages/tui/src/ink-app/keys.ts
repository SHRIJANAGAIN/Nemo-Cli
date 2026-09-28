/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Enter detection that survives terminals which deliver LF ('\n') instead of
 * CR ('\r'). Ink maps '\r' → key.return but '\n' → name 'enter' with
 * key.return === false, so a plain `if (key.return)` silently ignores Enter on
 * such terminals (submit/pick/expand all go dead while typing still works).
 */

export interface EnterKeyLike {
  return: boolean
}

export const isEnter = (input: string, key: EnterKeyLike): boolean => key.return || input === "\n" || input === "\r"

/** Ctrl-C double-press window: second press inside this exits when idle. */
export const CTRL_C_EXIT_WINDOW_MS = 1200

export type CtrlCAction = "abort" | "clear-draft" | "deny-dialog" | "arm" | "exit"

export interface CtrlCPress {
  /** A turn is currently running (interrupt it, never exit). */
  running: boolean
  /** Composer holds draft text (clear it, never exit). */
  hasDraft: boolean
  /** A permission/question dialog owns the input (deny it, never exit). */
  dialogOpen: boolean
  /** Epoch ms of the previous arming press (0/undefined = none). */
  lastPressAtMs?: number
  /** Now (epoch ms) — injectable for tests. */
  nowMs?: number
}

/** Pure Ctrl-C decision (unit-tested): interrupts output mid-turn, clears
 *  drafts, denies open dialogs, and only exits on a second press while
 *  idle with an empty composer. Single Ctrl-C never kills the session. */
export const resolveCtrlCPress = (press: CtrlCPress): CtrlCAction => {
  if (press.dialogOpen) return "deny-dialog"
  if (press.running) return "abort"
  if (press.hasDraft) return "clear-draft"
  const now = press.nowMs ?? Date.now()
  const last = press.lastPressAtMs ?? 0
  if (last > 0 && now - last <= CTRL_C_EXIT_WINDOW_MS) return "exit"
  return "arm"
}
