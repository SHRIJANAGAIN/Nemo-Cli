/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Permission-mode stack (SKT AI LABS parity): the linear Ctrl+P cycle plus an
 * explicit enter/exit pair so entering plan mode can return to exactly the
 * mode you came from. Pure — unit-tested; App owns the actual state.
 */

import type { PermissionMode } from "./types.js"

export interface ModeStackState {
  current: PermissionMode
  /** Frames to restore on exit (last = the mode plan was entered from). */
  stack: PermissionMode[]
}

/** Ctrl+P traversal order (unchanged from the original cycle). */
export const MODE_CYCLE: PermissionMode[] = ["read-only", "plan", "ask", "auto-approve", "full-access"]

/** Defensive validator for persisted/boot values (config file, env). */
export function isPermissionMode(v: unknown): v is PermissionMode {
  return v === "read-only" || v === "plan" || v === "ask" || v === "auto-approve" || v === "full-access"
}

/** Advance one step through MODE_CYCLE. Entering plan pushes the current
 * mode; leaving plan by cycling past it consumes the pushed frame (the cycle
 * moves linearly, so that frame is stale). Unknown modes restart at
 * read-only, matching the original behaviour. */
export function cycleMode(state: ModeStackState): ModeStackState {
  const idx = MODE_CYCLE.indexOf(state.current)
  const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length] ?? state.current
  if (next === state.current) return state
  if (next === "plan") return { current: next, stack: [...state.stack, state.current] }
  if (state.current === "plan") return { current: next, stack: state.stack.slice(0, -1) }
  return { current: next, stack: [...state.stack] }
}

/** Explicit switch (/mode <name>). Same mode → no-op (identity). Entering
 * plan pushes; leaving plan explicitly consumes the frame; other switches
 * leave the stack alone. */
export function enterMode(state: ModeStackState, mode: PermissionMode): ModeStackState {
  if (mode === state.current) return state
  if (mode === "plan") return { current: mode, stack: [...state.stack, state.current] }
  if (state.current === "plan") return { current: mode, stack: state.stack.slice(0, -1) }
  return { current: mode, stack: [...state.stack] }
}

/** /mode exit — restore the mode plan was entered from (default ask).
 * Identity (no-op) when not in plan mode. */
export function exitMode(state: ModeStackState): ModeStackState {
  if (state.current !== "plan") return state
  const stack = state.stack.slice(0, -1)
  const restored = state.stack[state.stack.length - 1] ?? "ask"
  return { current: restored, stack }
}

/** "ask → plan"-style breadcrumb for status/which-key display, or null. */
export function formatModeStack(state: ModeStackState): string | null {
  if (state.stack.length === 0) return null
  return `${state.stack.join(" → ")} → ${state.current}`
}
