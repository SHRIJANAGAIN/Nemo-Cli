/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext } from "../types.js"

export interface WorkflowStep {
  id: string
  action: string
  prompt?: string
  tool?: string
  args?: Record<string, unknown>
  condition?: string
  maxRetries?: number
  timeoutMs?: number
}

export interface WorkflowDefinition {
  name: string
  description: string
  steps: WorkflowStep[]
  maxSteps?: number
}

export interface WorkflowExecutionResult {
  success: boolean
  results: Array<{ stepId: string; output: string; error?: string }>
}

const MAX_WORKFLOW_STEPS = 20

export function validateWorkflow(def: WorkflowDefinition): string[] {
  const errors: string[] = []
  if (!def.name || typeof def.name !== "string") errors.push("Workflow 'name' is required and must be a string.")
  if (!def.description || typeof def.description !== "string")
    errors.push("Workflow 'description' is required and must be a string.")
  if (!Array.isArray(def.steps) || def.steps.length === 0) errors.push("Workflow must have at least one step.")
  if (def.steps.length > MAX_WORKFLOW_STEPS) errors.push(`Workflow steps exceed maximum of ${MAX_WORKFLOW_STEPS}.`)
  const seen = new Set<string>()
  for (const step of def.steps) {
    if (!step.id || typeof step.id !== "string") errors.push("Each step must have a string 'id'.")
    if (seen.has(step.id)) errors.push(`Duplicate step id: '${step.id}'.`)
    seen.add(step.id)
    if (!step.action || typeof step.action !== "string") errors.push(`Step '${step.id}' missing 'action'.`)
    if (step.maxRetries !== undefined && (typeof step.maxRetries !== "number" || step.maxRetries < 0)) {
      errors.push(`Step '${step.id}' maxRetries must be a non-negative number.`)
    }
    if (step.timeoutMs !== undefined && (typeof step.timeoutMs !== "number" || step.timeoutMs <= 0)) {
      errors.push(`Step '${step.id}' timeoutMs must be a positive number.`)
    }
  }
  return errors
}

export function executeWorkflow(
  def: WorkflowDefinition,
  ctx: { prompt: string; maxSteps?: number; onStep?: (step: WorkflowStep, output: string) => void },
): WorkflowExecutionResult {
  const boundedMax = Math.min(
    def.maxSteps ?? MAX_WORKFLOW_STEPS,
    ctx.maxSteps ?? MAX_WORKFLOW_STEPS,
    MAX_WORKFLOW_STEPS,
  )
  const results: Array<{ stepId: string; output: string; error?: string }> = []

  for (let i = 0; i < def.steps.length && i < boundedMax; i++) {
    const step = def.steps[i]
    try {
      const output = `[Step ${step.id}] Action: ${step.action}${step.prompt ? ` | Prompt: ${step.prompt.slice(0, 200)}` : ""}${step.tool ? ` | Tool: ${step.tool}` : ""}${step.args ? ` | Args: ${JSON.stringify(step.args).slice(0, 200)}` : ""}`
      results.push({ stepId: step.id, output })
      ctx.onStep?.(step, output)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      results.push({ stepId: step.id, output: "", error: message })
    }
  }

  return { success: results.every((r) => !r.error), results }
}

const runWorkflowDef: ToolDefinition = {
  name: "trayambak__RunWorkflow",
  description:
    "Execute a defined multi-step workflow with validation, bounded steps, and per-step result reporting. " +
    "Provide a workflow object with name, description, and ordered steps. Each step specifies an action and optional parameters.",
  parameters: {
    type: "object",
    required: ["workflow"],
    properties: {
      workflow: {
        type: "string",
        description:
          "JSON string of WorkflowDefinition: {name, description, steps[], maxSteps?}. Each step: {id, action, prompt?, tool?, args?, condition?, maxRetries?, timeoutMs?}.",
      },
    },
  },
}

export function createRunWorkflowTool(): Tool {
  return {
    definition: runWorkflowDef,
    async execute(_id, args, _signal, _update, context: ToolContext | undefined) {
      let workflow: WorkflowDefinition | undefined
      try {
        workflow = JSON.parse(String(args.workflow ?? "")) as WorkflowDefinition
      } catch {
        /* fall through to error message */
      }
      if (!workflow)
        return textResult("Missing or invalid 'workflow' parameter. Provide a JSON WorkflowDefinition.", true)

      const errors = validateWorkflow(workflow)
      if (errors.length > 0) {
        return textResult(`Workflow validation failed:\n${errors.map((e) => `- ${e}`).join("\n")}`, true)
      }

      const cwd = context?.cwd ?? process.cwd()
      const result = executeWorkflow(workflow, {
        prompt: "",
        maxSteps: workflow.maxSteps ?? MAX_WORKFLOW_STEPS,
        onStep: (step, output) => {
          try {
            const logPath = path.join(cwd, ".trayambak", "workflow-log.jsonl")
            const entry =
              JSON.stringify({ timestamp: new Date().toISOString(), stepId: step.id, action: step.action, output }) +
              "\n"
            fs.appendFileSync(logPath, entry)
          } catch {
            /* best-effort logging */
          }
        },
      })

      const summary = result.success
        ? `Workflow '${workflow.name}' completed successfully (${result.results.length}/${workflow.steps.length} steps).\n${result.results.map((r) => `${r.stepId}: ${r.output}`).join("\n")}`
        : `Workflow '${workflow.name}' completed with errors (${result.results.filter((r) => r.error).length} failures):\n${result.results.map((r) => `${r.stepId}: ${r.error ?? r.output}`).join("\n")}`
      return textResult(summary)
    },
  }
}
