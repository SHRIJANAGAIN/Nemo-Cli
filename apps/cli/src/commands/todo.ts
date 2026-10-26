/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

export interface TodoOptions {
  readonly action: "list" | "add" | "update" | "clear" | "read"
  readonly sessionId?: string
  readonly content?: string
  readonly id?: number
  readonly status?: "pending" | "in_progress" | "completed"
  readonly priority?: "low" | "medium" | "high"
  readonly dependsOn?: number[]
}

const TODO_DIR = path.join(os.homedir(), ".nemo", "todos")

/**
 * Session ids name a FILE under TODO_DIR, so they must be single path
 * segments (same rule as plan ids): `../config` would otherwise resolve to
 * ~/.nemo/config.json — parsed as a todo list on read, or overwritten
 * with `{"items":[]}` by a `clear`. Mirrors core's assertSessionId.
 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

function invalidSessionId(id: string): boolean {
  return !SESSION_ID_RE.test(id)
}

function todoFile(sessionId?: string): string {
  const id = sessionId && sessionId.trim() ? sessionId.trim() : "global"
  // Backstop for any future direct caller: the wrappers below pre-validate
  // so they can answer with a message instead of throwing.
  if (invalidSessionId(id)) throw new Error(`invalid session id: ${JSON.stringify(id)}`)
  return path.join(TODO_DIR, `${id}.json`)
}

/** undefined/blank → the documented global-list fallback (null = fine);
 *  a non-segment id → the id to reject at the command layer. */
function rejectedSessionId(sessionId: string | undefined): string | null {
  if (sessionId === undefined) return null
  const id = sessionId.trim()
  if (!id) return null
  return invalidSessionId(id) ? id : null
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

export function todoCommand(options: TodoOptions): string {
  const sessionId = options.sessionId
  const rejected = rejectedSessionId(sessionId)
  if (rejected !== null) return `Invalid session id: ${rejected}`
  const list = load(sessionId)

  switch (options.action) {
    case "list":
    case "read": {
      if (list.items.length === 0) return "(no todos)"
      return list.items
        .map(
          (i) =>
            `[${i.status === "completed" ? "x" : i.status === "in_progress" ? "*" : " "}] #${i.id}${i.priority ? ` (${i.priority})` : ""} ${i.content}`,
        )
        .join("\n")
    }
    case "add": {
      if (!options.content) return "Missing content"
      const item: TodoItem = {
        id: nextId(list),
        content: options.content,
        status: "pending",
        priority: options.priority,
        dependsOn: options.dependsOn && options.dependsOn.length > 0 ? options.dependsOn : undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      list.items.push(item)
      save(list, sessionId)
      return `added #${item.id}: ${item.content}`
    }
    case "update": {
      if (!options.id) return "Missing id"
      const item = list.items.find((i) => i.id === options.id!)
      if (!item) return `No todo with id ${options.id}`
      if (options.status) {
        item.status = options.status
        item.updatedAt = Date.now()
      }
      if (options.priority !== undefined) item.priority = options.priority
      if (options.dependsOn !== undefined) item.dependsOn = options.dependsOn
      save(list, sessionId)
      return `#${options.id} -> ${item.status}`
    }
    case "clear": {
      save({ items: [] }, sessionId)
      return "todos cleared"
    }
    default:
      return `Unknown todo action: ${options.action}`
  }
}

export function todoListForSession(sessionId?: string): TodoItem[] {
  if (rejectedSessionId(sessionId) !== null) return []
  return load(sessionId).items
}
