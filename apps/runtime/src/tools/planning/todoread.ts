/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext } from "../types.js"
import { loadTodoList } from "./todo.js"

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "todoread",
  description:
    "Read the current to-do list. Returns all items with their status, priority, and dependencies. Use this to see what tasks are planned, in progress, or completed before adding new items.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
}

export function createTodoReadTool(): Tool {
  return {
    definition,
    async execute(_id, _args, _signal, _update, context: ToolContext | undefined) {
      const sessionId = context?.sessionId
      const list = loadTodoList(sessionId)

      if (list.items.length === 0) {
        return textResult("(no todos)")
      }

      const lines = list.items.map(
        (i) =>
          `[${i.status === "completed" ? "x" : i.status === "in_progress" ? "*" : " "}] #${i.id}${i.priority ? ` (${i.priority})` : ""} ${i.content}${i.dependsOn && i.dependsOn.length > 0 ? ` [deps: ${i.dependsOn.join(", ")}]` : ""}`,
      )

      const counts = {
        total: list.items.length,
        pending: list.items.filter((i) => i.status === "pending").length,
        in_progress: list.items.filter((i) => i.status === "in_progress").length,
        completed: list.items.filter((i) => i.status === "completed").length,
      }

      return textResult(
        `Todos (${counts.pending} pending, ${counts.in_progress} in_progress, ${counts.completed} completed):\n${lines.join("\n")}`,
      )
    },
  }
}
