/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext } from "../types.js"
import { discoverAgentProfiles, type AgentProfile } from "../../agent/specialist-agents.js"
import { companyAgentDirs, resolveCompanyState } from "../../agent/company-library.js"

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "nemo__AgentCatalog",
  description:
    "List all available specialized subagents with their categories, descriptions, and capabilities for parallel execution.",
  parameters: {
    type: "object",
    required: [],
    properties: {
      category: {
        type: "string",
        enum: ["all", "architect", "reviewer", "resolver", "engineer", "planner", "optimizer", "specialist"],
        description: "Filter by agent category (default: 'all').",
      },
    },
  },
}

export function createAgentCatalogTool(): Tool {
  return {
    definition,
    async execute(_id, args, _signal, _update, context: ToolContext | undefined) {
      const filterCategory = (args.category as string) || "all"
      const companyState = resolveCompanyState(
        context?.config.companyDir,
        context?.cwd ?? process.cwd(),
        undefined,
        context?.config ?? null,
      )
      const companyDirs =
        companyState?.enabled === false ? [] : companyAgentDirs(companyState?.root, companyState?.disabled ?? [])
      const profiles = discoverAgentProfiles(context?.cwd ?? process.cwd(), [
        ...(context?.config.agentProfileDirs ?? []),
        ...companyDirs,
      ])

      if (profiles.length === 0) {
        return textResult("No specialist agent profiles found.")
      }

      const filtered = filterCategory === "all" ? profiles : profiles.filter((p) => p.category === filterCategory)

      // Group by category
      const grouped = new Map<string, AgentProfile[]>()
      for (const p of filtered) {
        const cat = p.category.toUpperCase()
        const list = grouped.get(cat) || []
        list.push(p)
        grouped.set(cat, list)
      }

      let output = `## Nemo Specialist Agent Catalog (${filtered.length} agents)\n\n`

      for (const [cat, list] of grouped.entries()) {
        output += `### ${cat} (${list.length})\n`
        for (const agent of list) {
          const desc = agent.description ? ` - ${agent.description}` : ""
          output += `- **\`${agent.name}\`**${desc}\n`
        }
        output += "\n"
      }

      output += `> Use with \`nemo__Agent\` (subagent_type), \`nemo__RunTeam\`, or \`nemo__ParallelReview\`.\n`

      return textResult(output)
    },
  }
}
