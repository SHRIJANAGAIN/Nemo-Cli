/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool } from "../types.js"

export interface TeamTask {
  name: string
  prompt: string
  subagentType?: string
  model?: string
  isolation?: string
  background?: boolean
}

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "trayambak__RunTeam",
  description:
    "Run independent specialist subagents in parallel with concurrency pooling, custom specialist roles, and unified aggregation.",
  parameters: {
    type: "object",
    required: ["tasks"],
    properties: {
      tasks: {
        type: "array",
        description: "Specialist subagent tasks to execute in parallel.",
        items: {
          type: "object",
          description:
            "Specialist task object with name, prompt, and optional subagent_type, model, isolation, or background.",
        },
      },
    },
  },
}

export function createTeamTool(
  onRunTeam?: (
    tasks: TeamTask[],
  ) => Promise<Array<{ name: string; text: string; error?: string; background?: boolean; subagentId?: string }>>,
): Tool {
  return {
    definition,
    async execute(_id, args) {
      if (!onRunTeam) return textResult("Team runner is unavailable.", /*isError*/ true)
      const raw = args.tasks
      if (!Array.isArray(raw) || raw.length === 0)
        return textResult("Missing non-empty 'tasks' array.", /*isError*/ true)
      const tasks: TeamTask[] = raw
        .map((item) => {
          const value = item as Record<string, unknown>
          return {
            name: String(value.name ?? "specialist"),
            prompt: String(value.prompt ?? ""),
            subagentType: value.subagent_type ? String(value.subagent_type) : undefined,
            model: value.model ? String(value.model) : undefined,
            isolation: value.isolation ? String(value.isolation) : undefined,
            background: value.background === true,
          }
        })
        .filter((task) => task.prompt.trim().length > 0)

      if (tasks.length === 0) return textResult("Each team task needs a prompt.", /*isError*/ true)
      const results = await onRunTeam(tasks)
      return textResult(
        results
          .map((result) => {
            if (result.error) return `[${result.name}] ERROR: ${result.error}`
            if (result.background)
              return `[${result.name}] Background task started (id: ${result.subagentId ?? "unknown"}).`
            return `[${result.name}]\n${result.text}`
          })
          .join("\n\n"),
      )
    },
  }
}
