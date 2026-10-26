/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Portions derived from OpenAI Codex CLI (codex-rs), Copyright 2025 OpenAI,
 * licensed under the Apache License, Version 2.0. See THIRD_PARTY_NOTICES.md.
 */

/**
 * What a model burns before the user's first message lands — system prompt,
 * tool schemas, AGENTS.md, the whole turn-zero context. Ported from codex-rs
 * `tui/src/token_usage.rs` (`BASELINE_TOKENS`).
 *
 * A window percentage measured against the raw context window is misleading at
 * both ends: a fresh session already shows several percent "used" for work the
 * user never did, and the pressure that actually matters — how much room is
 * left before the transcript has to be compacted — starts only after the
 * reserve. So the bar is drawn against `window - BASELINE_TOKENS`.
 */
export const BASELINE_TOKENS = 12_000

export interface SidebarContext {
  tokens: number
  /** null when the context window is unknown. */
  percent: number | null
  /** 0..1 across the USABLE slice (window minus the baseline reserve), or null
   *  when there is no usable slice to measure against. */
  usableFraction: number | null
}

/** Shrijan's sidebar Context math: current tokens against the model's context
 * window (capped at 100 — a compaction may lag a large paste). */
export function contextUsage(tokenCount: number, contextWindow?: number): SidebarContext {
  const tokens = Math.max(0, Math.round(tokenCount || 0))
  if (!contextWindow || contextWindow <= 0) return { tokens, percent: null, usableFraction: null }
  const percent = Math.min(100, Math.round((tokens / contextWindow) * 100))
  // A window at or under the reserve has no usable slice: reporting 0% would
  // claim free room that does not exist, and 100% would claim a full window the
  // model never had, so the bar stands down and `percent` carries the number.
  const usable = contextWindow - BASELINE_TOKENS
  const usableFraction = usable > 0 ? Math.min(1, Math.max(0, (tokens - BASELINE_TOKENS) / usable)) : null
  return { tokens, percent, usableFraction }
}

export interface Capped<T> {
  shown: T[]
  hidden: number
}

/** Keep the sidebar inside short terminals: show at most `max` rows and
 * report how many were trimmed. */
export function capItems<T>(items: readonly T[], max: number): Capped<T> {
  const limit = Math.max(0, max)
  const shown = items.slice(0, limit)
  return { shown, hidden: items.length - shown.length }
}

export interface McpRow {
  name: string
  transport: "stdio" | "http"
  target: string
}

/** config.mcpServers record → sidebar rows (stdio command vs http url). */
export function buildMcpRows(servers: Record<string, { command?: string[]; url?: string }> | undefined): McpRow[] {
  if (!servers) return []
  return Object.entries(servers).map(([name, spec]) => ({
    name,
    transport: spec.url ? ("http" as const) : ("stdio" as const),
    target: spec.url ?? (spec.command ? spec.command.join(" ") : ""),
  }))
}

export interface SidebarTodo {
  id: number
  content: string
  status: "pending" | "in_progress" | "completed"
  priority?: string
}

/** Exact `/todo list` marker format so the sidebar and the command agree:
 * `[x]` done, `[*]` in progress, `[ ]` pending. */
export function formatTodoLine(todo: SidebarTodo): string {
  const marker = todo.status === "completed" ? "x" : todo.status === "in_progress" ? "*" : " "
  const priority = todo.priority ? ` (${todo.priority})` : ""
  return `[${marker}] #${todo.id}${priority} ${todo.content}`
}

/** Shrijan hides the Todo section when the list is empty or everything is done. */
export function hasOpenTodos(todos: readonly SidebarTodo[]): boolean {
  return todos.length > 0 && todos.some((todo) => todo.status !== "completed")
}
