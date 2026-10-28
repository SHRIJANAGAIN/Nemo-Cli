/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { addTask, getTask, listTasks, resetTasks, updateTask } from "../../../runtime/src/tools/nemo/tasks.js"

export interface TaskOptions {
  readonly action: "list" | "create" | "update" | "get" | "output" | "reset"
  readonly id?: string
  readonly content?: string
  readonly status?: "pending" | "in_progress" | "completed"
  readonly priority?: "low" | "medium" | "high"
  readonly dependsOn?: string[]
}

const TASK_STATUSES = new Set(["pending", "in_progress", "completed"])

export function taskCommand(options: TaskOptions): string {
  switch (options.action) {
    case "list": {
      const tasks = listTasks()
      if (tasks.length === 0) return "No tasks"
      return tasks.map((t) => `${t.id} | ${t.status}${t.priority ? ` [${t.priority}]` : ""} | ${t.content}`).join("\n")
    }
    case "create": {
      if (!options.content) return "Missing content"
      // Really persists into the SAME store `list`, `reset`, and the
      // nemo__Task* tools use — "[Task queued]" must never be an empty
      // promise (it used to acknowledge without writing anything).
      addTask(options.content, { priority: options.priority, dependsOn: options.dependsOn })
      return `[Task queued] ${options.content.slice(0, 200)}`
    }
    case "update": {
      if (!options.id) return "Missing task id"
      if (options.status !== undefined && !TASK_STATUSES.has(options.status)) {
        return `Invalid status: ${options.status}`
      }
      if (options.status === undefined && options.priority === undefined) return "Missing status"
      const updated = updateTask(options.id, { status: options.status, priority: options.priority })
      if (!updated) return `No such task: ${options.id}`
      return `Task ${options.id} updated`
    }
    case "get": {
      if (!options.id) return "Missing task id"
      const t = getTask(options.id)
      if (!t) return `No such task: ${options.id}`
      return `${t.id} | ${t.status}${t.priority ? ` [${t.priority}]` : ""} | ${t.content}${t.result ? `\nresult: ${t.result}` : ""}`
    }
    case "output": {
      if (!options.id) return "Missing task id"
      const t = getTask(options.id)
      if (!t) return `No such task: ${options.id}`
      if (t.status !== "completed") return `Task not completed (status: ${t.status})`
      return t.result ?? "(no output)"
    }
    case "reset": {
      resetTasks()
      return "Tasks reset"
    }
    default:
      return `Unknown task action: ${options.action}`
  }
}
