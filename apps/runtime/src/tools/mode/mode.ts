/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool } from "../types.js"

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "set_mode",
  description: "Switch the agent behavior mode. Available modes: default, coder, browser, planner, sota, cot.",
  parameters: {
    type: "object",
    required: ["mode"],
    properties: {
      mode: {
        type: "string",
        enum: ["default", "coder", "browser", "planner", "sota", "cot"],
        description: "Target agent mode.",
      },
    },
  },
}

export function createModeTool(getMode: () => string, setMode: (mode: string) => void): Tool {
  return {
    definition,
    async execute(_id, args, _signal, _update, _context) {
      const requested = String(args.mode ?? "").toLowerCase()
      const valid = ["default", "coder", "browser", "planner", "sota", "cot"]
      if (!valid.includes(requested)) {
        return textResult(`Invalid mode "${requested}". Valid modes: ${valid.join(", ")}`, /*isError*/ true)
      }
      setMode(requested)
      return textResult(`Switched to ${requested} mode.`)
    },
  }
}

export function createGetModeTool(getMode: () => string): Tool {
  return {
    definition: {
      timeoutMs: 30_000,
      name: "get_mode",
      description: "Return the current agent behavior mode.",
      parameters: { type: "object", required: [], properties: {} },
    },
    async execute() {
      return textResult(`Current mode: ${getMode()}`)
    },
  }
}
