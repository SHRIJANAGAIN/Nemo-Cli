/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool } from "../types.js"

export interface ParallelExecuteOptions {
  plan: string
  taskType?: "frontend" | "backend" | "fullstack" | "refactor" | "audit"
  targetFiles?: string[]
  concurrency?: number
}

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "trayambak__ParallelExecute",
  description:
    "Multi-agent collaborative execution pipeline. Spawns specialized prototype and audit agents in parallel across frontend, backend, refactoring, and security boundaries.",
  parameters: {
    type: "object",
    required: ["plan"],
    properties: {
      plan: {
        type: "string",
        description: "The execution plan, requirements, or architecture task breakdown.",
      },
      taskType: {
        type: "string",
        enum: ["frontend", "backend", "fullstack", "refactor", "audit"],
        description: "Routing classification: 'frontend', 'backend', 'fullstack', 'refactor', or 'audit'.",
      },
      targetFiles: {
        type: "array",
        items: { type: "string", description: "Target file path." },
        description: "Key target file paths to modify or examine.",
      },
      concurrency: {
        type: "number",
        description: "Maximum parallel specialist subagents (default 4).",
      },
    },
  },
}

export function createParallelExecuteTool(
  onRunSubagents?: (
    tasks: Array<{ name: string; prompt: string; subagentType?: string }>,
  ) => Promise<Array<{ name: string; text: string; error?: string }>>,
): Tool {
  return {
    definition,
    async execute(_id, args, _signal, _update) {
      if (!onRunSubagents) return textResult("Team runner is unavailable.", /*isError*/ true)
      const plan = (args.plan as string) ?? ""
      if (!plan.trim()) {
        return textResult("Missing required parameter: plan", /*isError*/ true)
      }

      const taskType = (args.taskType as "frontend" | "backend" | "fullstack" | "refactor" | "audit") ?? "fullstack"
      const targetFiles = Array.isArray(args.targetFiles) ? (args.targetFiles as string[]) : []
      // Determine specialist roles based on taskType
      const parallelTasks: Array<{ name: string; prompt: string; subagentType: string }> = []

      if (taskType === "frontend") {
        parallelTasks.push({
          name: "Frontend Prototype Specialist",
          subagentType: "react-reviewer",
          prompt: `You are the Frontend UI & Component specialist.
Plan & Requirements:
${plan}

Target Files:
${targetFiles.join("\n")}

TASK:
Produce the UI/Component prototype, style implementations, accessibility considerations, and unified diff recommendations for the frontend. Return production-ready code proposals.`,
        })
      } else if (taskType === "backend") {
        parallelTasks.push({
          name: "Backend Architecture Specialist",
          subagentType: "architect",
          prompt: `You are the Backend Architecture & Logic specialist.
Plan & Requirements:
${plan}

Target Files:
${targetFiles.join("\n")}

TASK:
Produce the API contracts, data models, error handling, algorithms, and backend implementation prototype. Return production-ready code proposals.`,
        })
      } else if (taskType === "refactor") {
        parallelTasks.push(
          {
            name: "Refactor Cleaner Specialist",
            subagentType: "refactor-cleaner",
            prompt: `You are the Refactor Cleaner specialist.
Focus on dead code elimination, code simplification, performance bottlenecks, and modularity improvements.
Plan: ${plan}
Target Files: ${targetFiles.join(", ")}`,
          },
          {
            name: "Type Design Analyzer",
            subagentType: "type-design-analyzer",
            prompt: `You are the Type Design & Contract specialist.
Focus on type safety, strict contracts, schema consistency, and interface ergonomics.
Plan: ${plan}
Target Files: ${targetFiles.join(", ")}`,
          },
        )
      } else if (taskType === "audit") {
        parallelTasks.push(
          {
            name: "Code Quality Auditor",
            subagentType: "code-reviewer",
            prompt: `Audit the code changes and plan for logic correctness, error handling, and reliability.
Plan: ${plan}
Target Files: ${targetFiles.join(", ")}`,
          },
          {
            name: "Security Auditor",
            subagentType: "security-reviewer",
            prompt: `Audit the code changes and plan for OWASP top 10, authentication, injection, secrets, and data safety.
Plan: ${plan}
Target Files: ${targetFiles.join(", ")}`,
          },
        )
      } else {
        // Default Fullstack: Run Frontend and Backend Specialists in parallel!
        parallelTasks.push(
          {
            name: "Frontend Specialist",
            subagentType: "react-reviewer",
            prompt: `You are the Frontend Specialist running in parallel fullstack execution.
Analyze and construct the presentation, client state, and component changes.
Plan: ${plan}
Target Files: ${targetFiles.join(", ")}`,
          },
          {
            name: "Backend Specialist",
            subagentType: "architect",
            prompt: `You are the Backend Specialist running in parallel fullstack execution.
Analyze and construct the services, logic, endpoints, data flow, and backend interfaces.
Plan: ${plan}
Target Files: ${targetFiles.join(", ")}`,
          },
        )
      }

      const taskOutputs: Array<{ name: string; text: string; error?: string }> = await onRunSubagents(parallelTasks)

      let report = `## Parallel Multi-Agent Execution Report\n`
      report += `- **Task Type**: ${taskType}\n`
      report += `- **Specialists Executed Concurrently**: ${parallelTasks.length}\n`
      report += `- **Target Files**: ${targetFiles.length > 0 ? targetFiles.join(", ") : "All in scope"}\n\n`

      for (const res of taskOutputs) {
        report += `### 🔹 ${res.name}\n`
        if (res.error) {
          report += `> [!WARNING]\n> Execution failed: ${res.error}\n\n`
        } else {
          report += `${res.text.trim()}\n\n`
        }
      }

      report += `### Next Steps\n`
      report += `1. Synthesize specialist proposals into target files.\n`
      report += `2. Run \`trayambak__ParallelReview\` to verify changes across quality and security dimensions before committing.\n`

      return textResult(report)
    },
  }
}
