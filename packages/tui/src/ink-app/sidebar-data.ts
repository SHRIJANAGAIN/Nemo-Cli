/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

export interface SidebarContext {
  tokens: number
  /** null when the context window is unknown. */
  percent: number | null
}

/** SKT AI LABS's sidebar Context math: current tokens against the model's context
 * window (capped at 100 — a compaction may lag a large paste). */
export function contextUsage(tokenCount: number, contextWindow?: number): SidebarContext {
  const tokens = Math.max(0, Math.round(tokenCount || 0))
  if (!contextWindow || contextWindow <= 0) return { tokens, percent: null }
  const percent = Math.min(100, Math.round((tokens / contextWindow) * 100))
  return { tokens, percent }
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

/** SKT AI LABS hides the Todo section when the list is empty or everything is done. */
export function hasOpenTodos(todos: readonly SidebarTodo[]): boolean {
  return todos.length > 0 && todos.some((todo) => todo.status !== "completed")
}
