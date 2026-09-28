/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { BOLD, paint, type Theme } from "./theme"
import { renderBox, renderSelectRow, renderKvRow } from "./box"

export type FooterInfo = {
  cwd: string
  model?: string
  session?: string
  contextPercent?: number
  mcpCount?: number
  lspCount?: number
  permissions?: number
  connected?: boolean
}

/** Session footer: cwd | model | session | ctx% | mcp/lsp dots (truncated). */
export function renderFooter(info: FooterInfo): string {
  const parts: string[] = [paint("textMuted", info.cwd)]
  if (info.model) parts.push(paint("text", info.model))
  if (info.session) parts.push(paint("textMuted", info.session))
  if (typeof info.contextPercent === "number") {
    const token: keyof Theme = info.contextPercent > 80 ? "error" : info.contextPercent > 60 ? "warning" : "success"
    parts.push(paint(token, `ctx ${info.contextPercent}%`))
  }
  if (typeof info.mcpCount === "number") {
    const dot = info.mcpCount > 0 ? paint("success", "◉") : paint("textMuted", "○")
    parts.push(`${dot} ${paint("textMuted", `${info.mcpCount} MCP`)}`)
  }
  if (typeof info.lspCount === "number") {
    const dot = info.lspCount > 0 ? paint("success", "●") : paint("textMuted", "○")
    parts.push(`${dot} ${paint("textMuted", `${info.lspCount} LSP`)}`)
  }
  if (typeof info.permissions === "number" && info.permissions > 0) {
    parts.push(paint("warning", `△ ${info.permissions} permission${info.permissions > 1 ? "s" : ""}`))
  }
  return parts.join(paint("textMuted", "  ·  "))
}

export type KeybindRow = { key: string; action: string }

/** Two-column keybind help panel. */
export function renderKeybindPanel(bindings: KeybindRow[]): string {
  const col1 = bindings.filter((_, i) => i % 2 === 0)
  const col2 = bindings.filter((_, i) => i % 2 === 1)
  const rows = col1.map((b, i) => {
    const left = paint("primary", b.key.padEnd(12)) + paint("text", b.action.padEnd(24))
    const right = col2[i] ? paint("primary", col2[i].key.padEnd(12)) + paint("text", col2[i].action) : ""
    return left + right
  })
  return renderBox(rows.join("\n"), { title: "KEYBINDS", borderColor: "border", paddingX: 2 })
}

export type SelectItem = { label: string; description?: string; value?: string; disabled?: boolean }

/** Selectable list body (palettes pickers). Selection index supplied by caller. */
export function renderSelectBody(items: SelectItem[], selected: number): string[] {
  return items.map((it, i) =>
    it.disabled
      ? "  " + renderKvRow(it.label, it.description ?? "", "textMuted")
      : renderSelectRow(it.label, it.description, i === selected),
  )
}

/** Todo checklist item. */
export function renderTodoItem(status: string, content: string): string {
  if (status === "done") return paint("success", "[✓] ") + paint("textMuted", content)
  if (status === "in_progress") return paint("warning", "[•] ") + paint("text", content, BOLD)
  return paint("textMuted", "[ ] ") + paint("text", content)
}

/** Status dot line (connected/error/warn/neutral). */
export function renderStatusRow(label: string, state: "ok" | "error" | "warn" | "off", detail?: string): string {
  const token: keyof Theme =
    state === "ok" ? "success" : state === "error" ? "error" : state === "warn" ? "warning" : "textMuted"
  const dot = paint(token, state === "ok" ? "●" : state === "error" ? "✗" : state === "warn" ? "▲" : "○")
  return `${dot} ${paint("text", label)}${detail ? "  " + paint("textMuted", detail) : ""}`
}
