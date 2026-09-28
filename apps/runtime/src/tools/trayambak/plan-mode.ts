/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool } from "../types.js"

const definition: ToolDefinition = {
  name: "trayambak__EnterPlanMode",
  description: "Enter plan mode for designing implementation strategies. Returns a structured plan before executing.",
  parameters: {
    type: "object",
    required: ["description"],
    properties: {
      description: { type: "string", description: "What you are planning to do." },
    },
  },
}

export function createEnterPlanModeTool(onPlan?: (description: string) => Promise<string>): Tool {
  return {
    definition,
    async execute(_id, args, _signal, _update, _context) {
      const description = String(args.description ?? "")
      if (!description) return textResult("Missing 'description'.", true)
      if (onPlan) {
        const plan = await onPlan(description)
        return textResult(plan)
      }
      return textResult(
        `[plan mode entered]\n\nPlanning: ${description}\n\n(Plan generation not wired in headless mode — call site should provide a planner.)`,
      )
    },
  }
}
