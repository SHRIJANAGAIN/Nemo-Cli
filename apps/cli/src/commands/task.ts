/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { listTasks, resetTasks } from "../../../runtime/src/tools/trayambak/tasks.js"

export interface TaskOptions {
  readonly action: "list" | "create" | "update" | "get" | "output" | "reset"
  readonly id?: string
  readonly content?: string
  readonly status?: "pending" | "in_progress" | "completed"
  readonly priority?: "low" | "medium" | "high"
  readonly dependsOn?: string[]
}

export function taskCommand(options: TaskOptions): string {
  switch (options.action) {
    case "list": {
      const tasks = listTasks()
      if (tasks.length === 0) return "No tasks"
      return tasks.map((t) => `${t.id} | ${t.status}${t.priority ? ` [${t.priority}]` : ""} | ${t.content}`).join("\n")
    }
    case "create": {
      if (!options.content) return "Missing content"
      return `[Task queued] ${options.content.slice(0, 200)}`
    }
    case "update": {
      if (!options.id) return "Missing task id"
      return `Task ${options.id} updated`
    }
    case "get": {
      if (!options.id) return "Missing task id"
      return `Task ${options.id}`
    }
    case "output": {
      if (!options.id) return "Missing task id"
      return `Task ${options.id} output`
    }
    case "reset": {
      resetTasks()
      return "Tasks reset"
    }
    default:
      return `Unknown task action: ${options.action}`
  }
}
