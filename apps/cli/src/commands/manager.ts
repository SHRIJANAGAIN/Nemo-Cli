/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { loadConfig } from "../../../runtime/src/index.js"
import { listAgentProfiles } from "./agent.js"
import { listTasks } from "../../../runtime/src/tools/trayambak/tasks.js"
import { listPlans } from "./plan.js"
import { todoListForSession } from "./todo.js"

export interface ManagerOptions {
  readonly action: "status" | "agents" | "tasks" | "plans" | "todos" | "summary"
  readonly sessionId?: string
}

export function managerCommand(options: ManagerOptions): string {
  switch (options.action) {
    case "status": {
      const cfg = loadConfig()
      const lines = [
        "trayambak Manager Status",
        `cwd: ${cfg.cwd}`,
        `model: ${cfg.model}`,
        `provider: ${cfg.provider ?? "default"}`,
        `maxTurns: ${cfg.maxTurns}`,
        `maxParallelToolCalls: ${cfg.maxParallelToolCalls}`,
      ]
      return lines.join("\n")
    }
    case "agents": {
      const profiles = listAgentProfiles()
      if (profiles.length === 0) return "No agent profiles"
      return (
        `Available agents (${profiles.length}):\n` +
        profiles.map((p) => `  - ${p.id} [${p.category}] ${p.name}`).join("\n")
      )
    }
    case "tasks": {
      const tasks = listTasks()
      if (tasks.length === 0) return "No tasks"
      return `Tasks (${tasks.length}):\n` + tasks.map((t) => `  - ${t.id} | ${t.status} | ${t.content}`).join("\n")
    }
    case "plans": {
      const plans = listPlans()
      if (plans.length === 0) return "No plans"
      return `Plans (${plans.length}):\n` + plans.map((p) => `  - ${p.id}: ${p.name} [${p.status}]`).join("\n")
    }
    case "todos": {
      const todos = todoListForSession(options.sessionId)
      if (todos.length === 0) return "No todos"
      return `Todos (${todos.length}):\n` + todos.map((t) => `  - #${t.id} [${t.status}] ${t.content}`).join("\n")
    }
    case "summary": {
      const profiles = listAgentProfiles()
      const tasks = listTasks()
      const plans = listPlans()
      const todos = todoListForSession(options.sessionId)
      const lines = [
        "trayambak Manager Summary",
        `agents: ${profiles.length}`,
        `tasks: ${tasks.length}`,
        `plans: ${plans.length}`,
        `todos: ${todos.length}`,
      ]
      return lines.join("\n")
    }
    default:
      return `Unknown manager action: ${options.action}`
  }
}
