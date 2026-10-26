/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool } from "../types.js"

const TASKS_DIR = path.join(os.homedir(), ".nemo")
const TASKS_FILE = path.join(TASKS_DIR, "tasks.json")

export interface TaskItem {
  id: string
  content: string
  status: "pending" | "in_progress" | "completed"
  priority?: "low" | "medium" | "high"
  dependsOn?: string[]
  createdAt: number
  updatedAt: number
  result?: string
  batchId?: string
  batchMeta?: Record<string, unknown>
}

interface TaskStore {
  tasks: TaskItem[]
}

function loadStore(): TaskStore {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      return JSON.parse(fs.readFileSync(TASKS_FILE, "utf8")) as TaskStore
    }
  } catch {
    /* fall through */
  }
  return { tasks: [] }
}

function saveStore(store: TaskStore): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true })
  fs.writeFileSync(TASKS_FILE, JSON.stringify(store, null, 2), "utf8")
}

let idCounter = 0

function nextId(): string {
  return `task_${Date.now().toString(36)}_${(++idCounter).toString(36)}`
}

export function listTasks(): TaskItem[] {
  return loadStore().tasks
}

export function resetTasks(): void {
  saveStore({ tasks: [] })
  idCounter = 0
}

export function getTask(id: string): TaskItem | undefined {
  return loadStore().tasks.find((t) => t.id === id)
}

function putTask(task: TaskItem): void {
  const store = loadStore()
  const idx = store.tasks.findIndex((t) => t.id === task.id)
  if (idx >= 0) store.tasks[idx] = task
  else store.tasks.push(task)
  saveStore(store)
}

/**
 * The store's shared mutators. The CLI/slash `task` command used to fake
 * these ("[Task queued]" without persisting) while `list`/`reset` read the
 * real file — so every acknowledgement was a lie. One construction path
 * means a "queued" answer is always true for the tools AND the commands.
 */
export function addTask(
  content: string,
  opts: { priority?: unknown; dependsOn?: unknown; batchId?: unknown } = {},
): TaskItem {
  const task: TaskItem = {
    id: nextId(),
    content,
    status: "pending",
    priority: isPriority(opts.priority),
    dependsOn: Array.isArray(opts.dependsOn) ? (opts.dependsOn as string[]) : undefined,
    batchId: opts.batchId ? String(opts.batchId) : undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  putTask(task)
  return task
}

/** Applies defined fields only; returns null when the id is not in the store.
 *  Callers validate status before calling (the command layer owns the
 *  user-facing message for an unknown status word). */
export function updateTask(
  id: string,
  patch: { status?: TaskItem["status"]; priority?: unknown; result?: string },
): TaskItem | null {
  const t = getTask(id)
  if (!t) return null
  if (patch.status !== undefined) t.status = patch.status
  if (patch.priority !== undefined) t.priority = isPriority(patch.priority)
  if (patch.result !== undefined) t.result = patch.result
  t.updatedAt = Date.now()
  putTask(t)
  return t
}

const taskCreateDef: ToolDefinition = {
  timeoutMs: 30_000,
  name: "nemo__TaskCreate",
  description: "Create a new task in the nemo task list.",
  parameters: {
    type: "object",
    required: ["content"],
    properties: {
      content: { type: "string", description: "Task description." },
      priority: { type: "string", enum: ["low", "medium", "high"], description: "Task priority." },
      dependsOn: {
        type: "array",
        items: { type: "string", description: "ID of a task this one depends on" },
        description: "IDs of tasks this one depends on.",
      },
      batchId: { type: "string", description: "Optional batch identifier for parallel execution grouping." },
    },
  },
}

export function createTaskCreateTool(): Tool {
  return {
    definition: taskCreateDef,
    async execute(_id, args) {
      const content = String(args.content ?? "")
      if (!content) return textResult("Missing 'content'.", /*isError*/ true)
      const task = addTask(content, { priority: args.priority, dependsOn: args.dependsOn, batchId: args.batchId })
      return textResult(`Task ${task.id} created: ${content}`)
    },
  }
}

const taskUpdateDef: ToolDefinition = {
  timeoutMs: 30_000,
  name: "nemo__TaskUpdate",
  description: "Update the status of an existing task.",
  parameters: {
    type: "object",
    required: ["id", "status"],
    properties: {
      id: { type: "string", description: "Task ID." },
      status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "New status." },
      result: { type: "string", description: "Optional result output for the task." },
      priority: { type: "string", enum: ["low", "medium", "high"], description: "Task priority." },
    },
  },
}

export function createTaskUpdateTool(): Tool {
  return {
    definition: taskUpdateDef,
    async execute(_id, args) {
      const id = String(args.id ?? "")
      const status = String(args.status ?? "")
      const t = getTask(id)
      if (!t) return textResult(`No such task: ${id}`, /*isError*/ true)
      if (!["pending", "in_progress", "completed"].includes(status)) {
        return textResult(`Invalid status: ${status}`, /*isError*/ true)
      }
      updateTask(id, {
        status: status as TaskItem["status"],
        priority: args.priority,
        result: args.result !== undefined ? String(args.result) : undefined,
      })
      return textResult(`Task ${id} → ${status}`)
    },
  }
}

const taskGetDef: ToolDefinition = {
  timeoutMs: 30_000,
  name: "nemo__TaskGet",
  description: "Get details for a specific task.",
  parameters: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "Task ID." } },
  },
}

export function createTaskGetTool(): Tool {
  return {
    definition: taskGetDef,
    async execute(_id, args) {
      const t = getTask(String(args.id ?? ""))
      if (!t) return textResult("Not found", /*isError*/ true)
      return textResult(
        `${t.id} | ${t.status}${t.priority ? ` [${t.priority}]` : ""} | ${t.content}${t.result ? `\nresult: ${t.result}` : ""}`,
      )
    },
  }
}

const taskListDef: ToolDefinition = {
  timeoutMs: 30_000,
  name: "nemo__TaskList",
  description: "List all tasks in the nemo task list.",
  parameters: { type: "object", required: [], properties: {} },
}

export function createTaskListTool(): Tool {
  return {
    definition: taskListDef,
    async execute() {
      const all = listTasks()
      if (all.length === 0) return textResult("No tasks.")
      return textResult(
        all.map((t) => `${t.id} | ${t.status}${t.priority ? ` [${t.priority}]` : ""} | ${t.content}`).join("\n"),
      )
    },
  }
}

const taskOutputDef: ToolDefinition = {
  timeoutMs: 30_000,
  name: "nemo__TaskOutput",
  description: "Get the output/result for a completed task.",
  parameters: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "Task ID." } },
  },
}

export function createTaskOutputTool(): Tool {
  return {
    definition: taskOutputDef,
    async execute(_id, args) {
      const t = getTask(String(args.id ?? ""))
      if (!t) return textResult("Not found", /*isError*/ true)
      if (t.status !== "completed") return textResult(`Task not completed (status: ${t.status})`, /*isError*/ true)
      return textResult(t.result ?? "(no output)")
    },
  }
}

function isPriority(value: unknown): "low" | "medium" | "high" | undefined {
  if (value === "low" || value === "medium" || value === "high") return value
  return undefined
}

export function getTaskStorePath(): string {
  return TASKS_FILE
}
