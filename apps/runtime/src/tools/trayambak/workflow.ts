/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as path from "path"
import { createHash, randomUUID } from "crypto"
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

/** Stable hash of a step's identity: same hash means same work, safe to resume. */
export function stepHash(step: WorkflowStep): string {
  const canonical = JSON.stringify({
    id: step.id,
    action: step.action,
    prompt: step.prompt ?? "",
    tool: step.tool ?? "",
    args: step.args ?? {},
    condition: step.condition ?? "",
  })
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16)
}

export interface WorkflowRunStep {
  stepId: string
  hash: string
  output: string
  error?: string
}

export interface WorkflowRunRecord {
  runId: string
  name: string
  at: string
  steps: WorkflowRunStep[]
}

export function workflowRunsDir(cwd: string): string {
  return path.join(cwd, ".trayambak", "workflow-runs")
}

function validRunId(runId: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(runId)
}

export function saveWorkflowRun(cwd: string, record: WorkflowRunRecord): void {
  fs.mkdirSync(workflowRunsDir(cwd), { recursive: true })
  if (!validRunId(record.runId)) throw new Error(`Invalid runId: ${record.runId}`)
  fs.writeFileSync(path.join(workflowRunsDir(cwd), `${record.runId}.json`), JSON.stringify(record, null, 2), "utf8")
}

export function loadWorkflowRun(cwd: string, runId: string): WorkflowRunRecord | undefined {
  try {
    if (!validRunId(runId)) return undefined
    const file = path.join(workflowRunsDir(cwd), `${runId}.json`)
    if (!fs.existsSync(file)) return undefined
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as WorkflowRunRecord
    if (!raw || !Array.isArray(raw.steps)) return undefined
    return raw
  } catch {
    return undefined
  }
}

/**
 * Execute with resume: steps whose id+hash match the cached run at the same
 * index are reused (prefix walk — an edited step invalidates everything after
 * it, since later steps may depend on its output). Only edited or new steps
 * re-run, so a resumed run reproduces exactly.
 */
export function executeWorkflowResumed(
  def: WorkflowDefinition,
  ctx: {
    prompt: string
    maxSteps?: number
    onStep?: (step: WorkflowStep, output: string) => void
    resumeFrom?: WorkflowRunRecord
  },
): WorkflowExecutionResult & { reused: number } {
  const boundedMax = Math.min(
    def.maxSteps ?? MAX_WORKFLOW_STEPS,
    ctx.maxSteps ?? MAX_WORKFLOW_STEPS,
    MAX_WORKFLOW_STEPS,
  )
  const cached = ctx.resumeFrom?.steps ?? []
  const results: Array<{ stepId: string; output: string; error?: string }> = []
  let reused = 0
  let prefixBroken = false

  for (let i = 0; i < def.steps.length && i < boundedMax; i++) {
    const step = def.steps[i] as WorkflowStep
    const hit = prefixBroken ? undefined : cached[i]
    if (hit && hit.stepId === step.id && hit.hash === stepHash(step) && !hit.error) {
      results.push({ stepId: step.id, output: hit.output })
      reused++
      continue
    }
    prefixBroken = true
    try {
      const output = `[Step ${step.id}] Action: ${step.action}${step.prompt ? ` | Prompt: ${step.prompt.slice(0, 200)}` : ""}${step.tool ? ` | Tool: ${step.tool}` : ""}${step.args ? ` | Args: ${JSON.stringify(step.args).slice(0, 200)}` : ""}`
      results.push({ stepId: step.id, output })
      ctx.onStep?.(step, output)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      results.push({ stepId: step.id, output: "", error: message })
    }
  }

  return { success: results.every((r) => !r.error), results, reused }
}

const runWorkflowDef: ToolDefinition = {
  timeoutMs: 30_000,
  name: "trayambak__RunWorkflow",
  description:
    "Validate a workflow definition and print an ordered, resumable step plan: bounded steps, persisted run record, and reuse-on-resume. " +
    "This tool does NOT execute steps — the caller performs each action from the printed plan. " +
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
      resumeFromRunId: {
        type: "string",
        description:
          "Optional run id to resume: previously recorded steps with identical id+content are reused, only edited or new steps re-printed.",
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
        return textResult(
          "Missing or invalid 'workflow' parameter. Provide a JSON WorkflowDefinition.",
          /*isError*/ true,
        )

      const errors = validateWorkflow(workflow)
      if (errors.length > 0) {
        return textResult(`Workflow validation failed:\n${errors.map((e) => `- ${e}`).join("\n")}`, /*isError*/ true)
      }

      const cwd = context?.cwd ?? process.cwd()
      const resumeFrom =
        typeof args.resumeFromRunId === "string" && args.resumeFromRunId.length > 0
          ? loadWorkflowRun(cwd, String(args.resumeFromRunId))
          : undefined
      if (typeof args.resumeFromRunId === "string" && args.resumeFromRunId.length > 0 && !resumeFrom) {
        return textResult(`No workflow run found for id: ${String(args.resumeFromRunId)}`, /*isError*/ true)
      }
      const result = executeWorkflowResumed(workflow, {
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
        resumeFrom,
      })

      try {
        saveWorkflowRun(cwd, {
          runId: randomUUID(),
          name: workflow.name,
          at: new Date().toISOString(),
          steps: result.results.map((r, i) => ({
            stepId: r.stepId,
            hash: stepHash(workflow.steps[i] as WorkflowStep),
            output: r.output,
            ...(r.error ? { error: r.error } : {}),
          })),
        })
      } catch {
        /* run-record persistence is best-effort */
      }

      const summary = result.success
        ? `Workflow '${workflow.name}' plan ready: ${result.results.length}/${workflow.steps.length} steps printed (reused ${result.reused} from resume). This tool does not execute steps — run each action from the plan.\n${result.results.map((r) => `${r.stepId}: ${r.output}`).join("\n")}`
        : `Workflow '${workflow.name}' plan recorded with errors (${result.results.filter((r) => r.error).length} failures):\n${result.results.map((r) => `${r.stepId}: ${r.error ?? r.output}`).join("\n")}`
      return textResult(summary)
    },
  }
}
