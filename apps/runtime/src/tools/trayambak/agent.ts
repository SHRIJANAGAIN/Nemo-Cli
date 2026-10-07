/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as path from "path"
import * as fs from "fs"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext } from "../types.js"

export const AGENT_TYPES = ["general", "explore", "plan", "coder", "browser", "planner"] as const

const definition: ToolDefinition = {
  timeoutMs: 30_000,
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
          "The persona the subagent BECOMES (it runs as that role): a builtin (general, explore, plan, coder, browser, planner) or any specialist profile name — see trayambak__AgentCatalog, which includes the COMPANY roster (e.g. 'Code Reviewer'). Unknown names run as a general agent. If omitted, uses 'general'.",
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
      const isolation = (args.isolation as string) ?? undefined
      const background = (args.background as boolean) ?? false

      if (!prompt) {
        return textResult("Missing required parameter: prompt", /*isError*/ true)
      }

      if (onRunAgent) {
        const result = await onRunAgent({ description, prompt, subagentType, model, isolation, background: background })
        return textResult(result)
      }

      const summary = `[Subagent '${description}' requested]\n  - Type: ${subagentType}\n  - Model: ${model ?? "inherited"}\n  - Isolation: ${isolation ?? "inherit"}\n  - Background: ${background ? "yes" : "no"}\n  - Prompt: ${prompt.slice(0, 200)}${prompt.length > 200 ? "..." : ""}`

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
