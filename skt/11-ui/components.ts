/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { TerminalUI, COLOR } from "../../packages/tui/src/index.js"

/** Trayambak-style status bar shown at the bottom of the terminal. */
export function renderStatusBar(
  ui: TerminalUI,
  state: {
    model: string
    tokens: number
    points: number
    errors: number
    session: string
    voiceOn: boolean
  },
): void {
  const voice = state.voiceOn ? `${COLOR.green} MIC ON${COLOR.reset}` : `${COLOR.dim} mic off${COLOR.reset}`
  const line = `${COLOR.cyan}│${COLOR.reset} ${COLOR.bold}${state.model}${COLOR.reset} ${COLOR.cyan}│${COLOR.reset} tok:${state.tokens} ${COLOR.cyan}│${COLOR.reset} pts:${state.points} ${COLOR.cyan}│${COLOR.reset} err:${state.errors} ${COLOR.cyan}│${COLOR.reset} ${voice} ${COLOR.cyan}│${COLOR.reset} ${COLOR.dim}${state.session}${COLOR.reset}`
  ui.line("")
  ui.line(`${COLOR.cyan}└${"─".repeat(70)}┘${COLOR.reset}`)
  ui.line(line)
}

/** Trayambak-style tab bar for switching between views. */
export function renderTabBar(ui: TerminalUI, tabs: string[], active: number): void {
  const parts = tabs.map((t, i) =>
    i === active ? `${COLOR.bgBlue}${COLOR.black} ${t} ${COLOR.reset}` : `${COLOR.dim} ${t} ${COLOR.reset}`,
  )
  ui.line(`${COLOR.cyan}┌${"─".repeat(70)}┐${COLOR.reset}`)
  ui.line(`${COLOR.cyan}│${COLOR.reset}${parts.join("")} ${COLOR.cyan}│${COLOR.reset}`)
}

/** Trayambak-style spinner with task label. */
export function renderTaskSpinner(ui: TerminalUI, label: string, frame: number): void {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  const glyph = frames[frame % frames.length]
  process.stdout.write(`\r  ${COLOR.cyan}${glyph}${COLOR.reset} ${COLOR.dim}${label}${COLOR.reset}    `)
}

/** Trayambak-style progress bar. */
export function renderProgressBar(ui: TerminalUI, label: string, current: number, total: number, width = 40): void {
  const pct = total > 0 ? current / total : 0
  const filled = Math.round(width * pct)
  const bar = `${COLOR.green}${"█".repeat(filled)}${COLOR.dim}${"░".repeat(width - filled)}${COLOR.reset}`
  process.stdout.write(
    `  ${COLOR.dim}${label}${COLOR.reset} ${bar} ${COLOR.bold}${Math.round(pct * 100)}%${COLOR.reset}\n`,
  )
}

/** Trayambak-style notification toast. */
export function renderToast(
  ui: TerminalUI,
  message: string,
  type: "info" | "success" | "warning" | "error" = "info",
): void {
  const icon = { info: "ℹ", success: "✓", warning: "⚠", error: "✗" }[type]
  const color = { info: COLOR.cyan, success: COLOR.green, warning: COLOR.yellow, error: COLOR.red }[type] ?? COLOR.cyan
  ui.line(`  ${color}${icon}${COLOR.reset} ${message}`)
}

/** Trayambak-style diff view for showing changes. */
export function renderDiff(ui: TerminalUI, filename: string, additions: number, deletions: number): void {
  ui.line(
    `  ${COLOR.cyan}${filename}${COLOR.reset} ${COLOR.green}+${additions}${COLOR.reset} ${COLOR.red}-${deletions}${COLOR.reset}`,
  )
}

/** Trayambak-style code block with syntax indicator. */
export function renderCodeBlock(ui: TerminalUI, code: string, language: string): void {
  const lines = code.split("\n")
  const openFence = "```"
  const closeFence = "```"
  ui.line(`  ${COLOR.cyan}${openFence}${language}${COLOR.reset}`)
  for (const l of lines.slice(0, 20)) {
    ui.line(`  ${COLOR.dim}│${COLOR.reset} ${l}`)
  }
  if (lines.length > 20) ui.line(`  ${COLOR.dim}│${COLOR.reset} ... (${lines.length - 20} more lines)`)
  ui.line(`  ${COLOR.cyan}${closeFence}${COLOR.reset}`)
}
