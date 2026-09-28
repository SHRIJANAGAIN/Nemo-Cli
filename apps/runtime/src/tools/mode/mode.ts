/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool } from "../types.js"

const definition: ToolDefinition = {
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
        return textResult(`Invalid mode "${requested}". Valid modes: ${valid.join(", ")}`, true)
      }
      setMode(requested)
      return textResult(`Switched to ${requested} mode.`)
    },
  }
}

export function createGetModeTool(getMode: () => string): Tool {
  return {
    definition: {
      name: "get_mode",
      description: "Return the current agent behavior mode.",
      parameters: { type: "object", required: [], properties: {} },
    },
    async execute() {
      return textResult(`Current mode: ${getMode()}`)
    },
  }
}
