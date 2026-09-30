/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool } from "../types.js"

const TODO_DIR = path.join(os.homedir(), ".trayambak", "todos")

function todoFile(sessionId?: string): string {
  const id = sessionId && sessionId.trim() ? sessionId.trim() : "global"
  return path.join(TODO_DIR, `${id}.json`)
}

interface TodoItem {
  id: number
  content: string
  status: "pending" | "in_progress" | "completed"
  priority?: "low" | "medium" | "high"
  dependsOn?: number[]
  createdAt: number
  updatedAt: number
}

interface TodoList {
  items: TodoItem[]
  /** Snapshot of items before the last update, for diff rendering. */
  before?: TodoItem[]
}

function load(sessionId?: string): TodoList {
  try {
    const file = todoFile(sessionId)
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as TodoList
  } catch {
    /* fall through */
  }
  return { items: [] }
}

function save(list: TodoList, sessionId?: string): void {
  const file = todoFile(sessionId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(list, null, 2), "utf8")
}

function nextId(list: TodoList): number {
  return list.items.length === 0 ? 1 : Math.max(...list.items.map((i) => i.id)) + 1
}

/** Render a TodoList, showing only changes since the last snapshot (SKT AI LABS TodoView diff). */
function renderTodoDiff(list: TodoList): string {
  const before = list.before ?? []
  const after = list.items

  if (after.length === 0) return "(no todos)"

  // If no snapshot, show full list
  if (!list.before) {
    return renderFull(after)
  }

  // Check if structural change (different length or content)
  const structural =
    before.length !== after.length || after.some((todo, index) => before[index]?.content !== todo.content)

  // Check if terminal (all completed/cancelled) - show full list
  const terminal = after.every((todo) => todo.status === "completed")

  // Find changed items
  const changes = after
    .map((todo, index) => ({
      index,
      changed: !sameTodo(before[index], todo),
    }))
    .filter((item) => item.changed)

  // If no structural change and no terminal and no changes, show nothing new
  if (!structural && !terminal && changes.length === 0) {
    return "(no changes)"
  }

  // Wide view: structural change, terminal, or no diff items
  if (structural || terminal || changes.length === 0) {
    return renderFull(after)
  }

  // Compact view: show only changed items with context
  const firstChanged = Math.max(0, Math.min(...changes.map((item) => item.index)) - 1)
  const lastChanged = Math.min(after.length - 1, Math.max(...changes.map((item) => item.index)) + 1)

  const lines = []
  for (let i = firstChanged; i <= lastChanged; i++) {
    const todo = after[i]
    if (!todo) continue
    const changed = changes.some((c) => c.index === i)
    const marker = changed ? ">" : " "
    lines.push(formatTodo(todo, marker))
  }

  const hiddenBefore = firstChanged
  const hiddenAfter = after.length - lastChanged - 1
  if (hiddenBefore > 0 || hiddenAfter > 0) {
    lines.unshift(`... ${hiddenBefore} hidden before, ${hiddenAfter} hidden after ...`)
  }

  return lines.join("\n")
}

function sameTodo(before: TodoItem | undefined, after: TodoItem): boolean {
  if (!before) return false
  return (
    before.content === after.content &&
    before.status === after.status &&
    JSON.stringify(before.priority) === JSON.stringify(after.priority)
  )
}

function renderFull(items: TodoItem[]): string {
  if (items.length === 0) return "(no todos)"
  return items.map((i) => formatTodo(i, " ")).join("\n")
}

function formatTodo(i: TodoItem, marker: string): string {
  const statusIcon = i.status === "completed" ? "x" : i.status === "in_progress" ? "*" : " "
  const priority = i.priority ? ` (${i.priority})` : ""
  return `${marker}[${statusIcon}] #${i.id}${priority} ${i.content}`
}

export function createTodoTool(): Tool {
  const definition: ToolDefinition = {
    timeoutMs: 30_000,
    name: "todo",
    description:
      "Maintain a small session-scoped to-do list. Use to plan multi-step work: write, read, or update items. Uses diff rendering to show only changes since last update.",
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["read", "write", "update", "clear"],
          description: "The operation to perform on the to-do list.",
        },
        id: { type: "integer", description: "Item id (for update)." },
        content: { type: "string", description: "Item text (for write)." },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed"],
          description: "New status for the item (for update).",
        },
        priority: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Priority for the item (for write/update).",
        },
        dependsOn: {
          type: "array",
          items: { type: "integer", description: "ID of a todo this one depends on" },
          description: "IDs of items this one depends on (for write/update).",
        },
      },
    },
  }

  return {
    definition,
    async execute(_id, args, signal, _update, context) {
      if (signal?.aborted) return textResult("aborted", /*isError*/ true)
      const sessionId = context?.sessionId
      const action = String(args.action ?? "")
      const list = load(sessionId)

      if (action === "read") {
        return textResult(renderFull(list.items))
      }
      if (action === "write") {
        const content = String(args.content ?? "").trim()
        if (!content) return textResult("Missing 'content'.", /*isError*/ true)

        // Snapshot before mutation for diff
        list.before = [...list.items]

        const item: TodoItem = {
          id: nextId(list),
          content,
          status: "pending",
          priority: isPriority(args.priority),
          dependsOn: Array.isArray(args.dependsOn) ? (args.dependsOn as number[]) : undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        list.items.push(item)
        save(list, sessionId)
        return textResult(renderTodoDiff(list))
      }
      if (action === "update") {
        const id = Number(args.id)
        const status = String(args.status ?? "")
        if (!Number.isInteger(id) || !status) return textResult("Need numeric 'id' and 'status'.", /*isError*/ true)
        const item = list.items.find((i) => i.id === id)
        if (!item) return textResult(`No todo with id ${id}.`, /*isError*/ true)
        if (status !== "pending" && status !== "in_progress" && status !== "completed")
          return textResult("status must be pending|in_progress|completed", /*isError*/ true)

        // Snapshot before mutation for diff
        list.before = [...list.items]

        item.status = status
        item.updatedAt = Date.now()
        if (args.priority !== undefined) item.priority = isPriority(args.priority)
        if (args.dependsOn !== undefined)
          item.dependsOn = Array.isArray(args.dependsOn) ? (args.dependsOn as number[]) : undefined
        save(list, sessionId)
        return textResult(renderTodoDiff(list))
      }
      if (action === "clear") {
        list.before = [...list.items]
        list.items = []
        save(list, sessionId)
        return textResult("(todos cleared)")
      }
      return textResult("action must be read|write|update|clear", /*isError*/ true)
    },
  }
}

function isPriority(value: unknown): "low" | "medium" | "high" | undefined {
  if (value === "low" || value === "medium" || value === "high") return value
  return undefined
}

export function loadTodoList(sessionId?: string): TodoList {
  return load(sessionId)
}

export { renderTodoDiff, renderFull }
