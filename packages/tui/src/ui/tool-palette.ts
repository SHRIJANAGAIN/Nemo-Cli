/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Shared palette + key shortcut constants ported from the Trayambak Code
 * reference TUI (`history_cell/mcp.rs` and `exec_cell/render.rs`):
 *
 *  - Bullet: success = green bold, failure = red bold, in-progress = spinner
 *    / dim.
 *  - Invocation: server cyan, tool cyan, args dim.
 *  - Titles (Called / Calling / Running / Ran / You ran / Exploring /
 *    Explored) are bold; Exploring/Explored sub-type (Read/List/Search/Run)
 *    is cyan.
 *  - Output/result lines are dim; transcript `$` prefix is magenta; tree
 *    prefix `└` / indents are dim.
 *  - Result: ✓ green bold, ✗ red bold (+ exit code), duration dim.
 *
 * The palette mirrors ratatui::style::Stylize's green/red/cyan/magenta/
 * yellow/blue/dim/bold used across the whole UI.
 */

import { paint, fg, DIM, RESET, getTheme, type Theme, type Rgb } from "./theme"

export type ToolStatus = "success" | "failure" | "running"

/** Reference action palette (ratatui Stylize colors). */
export const PALETTE = {
  success: "\x1b[32m", // green
  failure: "\x1b[31m", // red
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
} as const

/** Shortcut keys ported from the reference keymap (common actions).
 *  Every chord is unique: copy/yolo shared Ctrl+Y, openTranscript/
 *  expandResult shared Ctrl+O, and toggleVim/toggleVimMode shared Ctrl+G —
 *  one action shadowed the other wherever the map is displayed. */
export const SHORTCUTS = {
  submit: "Enter",
  interrupt: "Ctrl+C",
  newline: "Alt+Enter",
  queue: "Ctrl+Enter",
  openTranscript: "Ctrl+O",
  copy: "Ctrl+Y",
  toggleFastMode: "Ctrl+B",
  openExternalEditor: "Ctrl+E",
  toggleVimMode: "Ctrl+G",
  deleteWordBackward: "Alt+Backspace",
  deleteWordForward: "Alt+Delete",
  moveWordLeft: "Alt+Left",
  moveWordRight: "Alt+Right",
  toggleVim: "Alt+G",
  toggleNotifications: "Ctrl+N",
  togglePermission: "Ctrl+P",
  expandResult: "Alt+O",
  help: "Ctrl+H",
  deny: "Ctrl+X",
  approve: "Ctrl+A",
  yolo: "Alt+Y",
} as const

export interface ToolInvocation {
  server: string
  tool: string
  args: Record<string, unknown>
}

/** `server.tool(args)` — server cyan, tool cyan, args dim. */
export function formatInvocation(inv: ToolInvocation): string {
  const args = JSON.stringify(inv.args ?? {})
  return `${PALETTE.cyan}${inv.server}${PALETTE.reset}.${PALETTE.cyan}${inv.tool}${PALETTE.reset}(${PALETTE.dim}${args}${PALETTE.reset})`
}

/** Bullet: green bold / red bold / dim fallback for in-progress. */
export function bullet(status: ToolStatus): string {
  if (status === "success") return `${PALETTE.success}${PALETTE.bold}\u2022${PALETTE.reset}`
  if (status === "failure") return `${PALETTE.failure}${PALETTE.bold}\u2022${PALETTE.reset}`
  return `${PALETTE.dim}\u2022${PALETTE.reset}`
}

/** Called/Calling/Running/etc. title — bold. */
export function title(text: string): string {
  return `${PALETTE.bold}${text}${PALETTE.reset}`
}

/** Exploring sub-type (Read / List / Search / Run) — cyan. */
export function subTitle(text: string): string {
  return `${PALETTE.cyan}${text}${PALETTE.reset}`
}

/** Result line: ✓ green bold / ✗ red bold (+ exit code); duration dim. */
export function resultLine(ok: boolean, exitCode?: number, durationMs?: number): string {
  const mark = ok
    ? `${PALETTE.success}${PALETTE.bold}\u2713${PALETTE.reset}`
    : `${PALETTE.failure}${PALETTE.bold}\u2717${PALETTE.reset}${exitCode !== undefined ? ` (${exitCode})` : ""}`
  const dur = durationMs !== undefined ? `${PALETTE.dim} \u2022 ${durationMs}ms${PALETTE.reset}` : ""
  return mark + dur
}

/** Output/result line — dim. */
export function outputLine(text: string): string {
  return `${PALETTE.dim}${text}${PALETTE.reset}`
}

/** Transcript command line with `$` prefix — magenta. */
export function commandLine(text: string): string {
  return `${PALETTE.magenta}$ ${PALETTE.reset}${text}`
}

/** Tree prefix `└` / indents — dim. */
export function treePrefix(text = "\u2514 "): string {
  return `${PALETTE.dim}${text}${PALETTE.reset}`
}

/** Theme-aware equivalents (truecolor from active theme). */
export interface ThemePaint {
  success: (s: string, attrs?: string) => string
  failure: (s: string, attrs?: string) => string
  cyan: (s: string, attrs?: string) => string
  magenta: (s: string, attrs?: string) => string
  dim: (s: string, attrs?: string) => string
}

export function themePaint(): ThemePaint {
  const t = getTheme() as Theme
  const c = (key: keyof Theme, s: string, attrs = ""): string => {
    const rgb = t[key] as unknown as Rgb
    if (!rgb || typeof rgb !== "object" || !("r" in rgb)) return s
    return `${attrs}${fg(rgb)}${s}${RESET}`
  }
  return {
    success: (s, a) => c("success", s, a),
    failure: (s, a) => c("error", s, a),
    cyan: (s, a) => c("accent", s, a),
    magenta: (s, a) => c("secondary", s, a),
    dim: (s) => `${DIM}${s}${RESET}`,
  }
}

/** Alias kept for callers that already reference `paint`. */
export const paintToken = paint
