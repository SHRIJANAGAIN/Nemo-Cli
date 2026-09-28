/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as path from "path"
import * as fs from "fs"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext } from "../types.js"

export const AGENT_TYPES = ["general", "explore", "plan", "coder", "browser", "planner"] as const

const definition: ToolDefinition = {
  name: "trayambak__Agent",
  description:
    "Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it. Useful for independent research, exploration, or sub-tasks that benefit from isolation.",
  parameters: {
    type: "object",
    required: ["description", "prompt"],
    properties: {
      description: {
        type: "string",
        description: "A short (3-5 word) description of the task the subagent should perform.",
      },
      prompt: {
        type: "string",
        description: "The full task prompt for the subagent. Be detailed and specific.",
      },
      subagent_type: {
        type: "string",
        description:
          "The type of specialized agent to use. Valid types: general, explore, plan, coder, browser, planner. If omitted, uses 'general'.",
        enum: ["general", "explore", "plan", "coder", "browser", "planner"],
      },
      model: {
        type: "string",
        description: "Optional model override (e.g. 'fable', 'sonnet', 'opus', 'haiku').",
      },
      isolation: {
        type: "string",
        description: "Isolation mode: 'worktree' creates a temporary git worktree, 'remote' launches in cloud.",
      },
      background: {
        type: "boolean",
        description:
          "Run the agent in the background. Returns immediately without waiting for completion. You will be notified when it finishes.",
      },
    },
  },
}

export function createAgentTool(
  onRunAgent?: (params: {
    description: string
    prompt: string
    subagentType?: string
    model?: string
    isolation?: string
    background?: boolean
  }) => Promise<string>,
): Tool {
  return {
    definition,
    async execute(_toolCallId, args, _signal, _update, _context: ToolContext | undefined) {
      const description = (args.description as string) ?? "subagent task"
      const prompt = (args.prompt as string) ?? ""
      const subagentType = (args.subagent_type as string) ?? "general"
      const model = (args.model as string) ?? undefined
      const isolation = (args.isolation as string) ?? "worktree"
      const background = (args.background as boolean) ?? false

      if (!prompt) {
        return textResult("Missing required parameter: prompt", true)
      }

      if (onRunAgent) {
        const result = await onRunAgent({ description, prompt, subagentType, model, isolation, background: background })
        return textResult(result)
      }

      const summary = `[Subagent '${description}' requested]\n  - Type: ${subagentType}\n  - Model: ${model ?? "inherited"}\n  - Isolation: ${isolation}\n  - Background: ${background ? "yes" : "no"}\n  - Prompt: ${prompt.slice(0, 200)}${prompt.length > 200 ? "..." : ""}`

      const devDir = path.join(_context?.cwd ?? process.cwd(), ".trayambak", "dev")
      try {
        if (!fs.existsSync(devDir)) fs.mkdirSync(devDir, { recursive: true })
        const logPath = path.join(devDir, "subagent-requests.jsonl")
        const entry = JSON.stringify({
          timestamp: new Date().toISOString(),
          description,
          prompt,
          subagentType,
          model,
          isolation,
          background,
        })
        fs.appendFileSync(logPath, entry + "\n")
      } catch {
        // best-effort logging
      }

      return textResult(summary)
    },
  }
}
