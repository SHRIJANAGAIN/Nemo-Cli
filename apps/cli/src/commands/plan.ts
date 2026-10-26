/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

export interface PlanOptions {
  readonly action: "create" | "add-step" | "update-step" | "complete" | "list" | "show"
  readonly name?: string
  readonly description?: string
  readonly planId?: string
  readonly stepId?: string
  readonly stepDescription?: string
  readonly status?: "pending" | "in_progress" | "completed" | "blocked"
}

const PLAN_DIR = path.join(os.homedir(), ".nemo", "plans")

/**
 * Plan ids are single path segments by construction (`plan-<base36>`), so
 * anything a caller (slash handler, CLI arg) hands us must clear this BEFORE
 * it reaches a path join: `../../secret` would otherwise read/write `.json`
 * files outside `~/.nemo/plans`. Same shape as the session-id choke
 * point in packages/core validate.
 */
const PLAN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

const STEP_STATUSES = new Set(["pending", "in_progress", "completed", "blocked"])

function invalidPlanId(id: string): boolean {
  return !PLAN_ID_RE.test(id)
}

function planFile(id: string): string {
  // Backstop: savePlan() writes where the FILE's id says, so a crafted
  // plan JSON must not be able to aim the write outside the plans root.
  if (invalidPlanId(id)) throw new Error(`invalid plan id: ${JSON.stringify(id)}`)
  return path.join(PLAN_DIR, `${id}.json`)
}

interface PlanStep {
  id: string
  description: string
  status: "pending" | "in_progress" | "completed" | "blocked"
  result?: string
  createdAt: number
  updatedAt: number
}

interface Plan {
  id: string
  name: string
  description: string
  steps: PlanStep[]
  status: "active" | "completed" | "abandoned"
  createdAt: number
  updatedAt: number
}

function loadPlan(id: string): Plan | undefined {
  try {
    const file = planFile(id)
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as Plan
  } catch {
    /* fall through */
  }
  return undefined
}

function savePlan(plan: Plan): void {
  const file = planFile(plan.id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(plan, null, 2), "utf8")
}

function listPlanFiles(): string[] {
  try {
    if (!fs.existsSync(PLAN_DIR)) return []
    return fs
      .readdirSync(PLAN_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
  } catch {
    return []
  }
}

export function planCommand(options: PlanOptions): string {
  switch (options.action) {
    case "create": {
      if (!options.name) return "Missing plan name"
      const id = `plan-${Date.now().toString(36)}`
      const plan: Plan = {
        id,
        name: options.name,
        description: options.description ?? "",
        steps: [],
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      savePlan(plan)
      return `Created plan ${id}: ${plan.name}`
    }
    case "add-step": {
      if (!options.planId) return "Missing plan id"
      if (invalidPlanId(options.planId)) return `Invalid plan id: ${options.planId}`
      if (!options.stepDescription) return "Missing step description"
      const plan = loadPlan(options.planId)
      if (!plan) return `Plan not found: ${options.planId}`
      const step: PlanStep = {
        id: `step-${Date.now().toString(36)}`,
        description: options.stepDescription,
        status: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      plan.steps.push(step)
      plan.updatedAt = Date.now()
      savePlan(plan)
      return `Added step ${step.id}: ${step.description}`
    }
    case "update-step": {
      if (!options.planId || !options.stepId) return "Missing plan id or step id"
      if (invalidPlanId(options.planId)) return `Invalid plan id: ${options.planId}`
      // Status is persisted verbatim into the plan JSON — an unknown word
      // would wedge the file with a value the UI can never render.
      if (options.status !== undefined && !STEP_STATUSES.has(options.status)) {
        return `Invalid status: ${options.status}`
      }
      const plan = loadPlan(options.planId)
      if (!plan) return `Plan not found: ${options.planId}`
      const step = plan.steps.find((s) => s.id === options.stepId!)
      if (!step) return `Step not found: ${options.stepId}`
      if (options.status) {
        step.status = options.status
        step.updatedAt = Date.now()
      }
      if (options.stepDescription !== undefined) {
        step.description = options.stepDescription
        step.updatedAt = Date.now()
      }
      savePlan(plan)
      return `Updated step ${step.id} -> ${step.status}`
    }
    case "complete": {
      if (!options.planId) return "Missing plan id"
      if (invalidPlanId(options.planId)) return `Invalid plan id: ${options.planId}`
      const plan = loadPlan(options.planId)
      if (!plan) return `Plan not found: ${options.planId}`
      plan.status = "completed"
      plan.updatedAt = Date.now()
      savePlan(plan)
      return `Completed plan ${plan.id}`
    }
    case "list": {
      const ids = listPlanFiles()
      if (ids.length === 0) return "No plans"
      const plans = ids.map((id) => loadPlan(id)).filter((p): p is Plan => p !== undefined)
      return plans.map((p) => `${p.id}: ${p.name} [${p.status}] (${p.steps.length} steps)`).join("\n")
    }
    case "show": {
      if (!options.planId) return "Missing plan id"
      if (invalidPlanId(options.planId)) return `Invalid plan id: ${options.planId}`
      const plan = loadPlan(options.planId)
      if (!plan) return `Plan not found: ${options.planId}`
      const lines = [
        `${plan.id}: ${plan.name}`,
        `Status: ${plan.status}`,
        `Description: ${plan.description || "(none)"}`,
        "Steps:",
      ]
      for (const s of plan.steps) {
        lines.push(
          `  [${s.status === "completed" ? "x" : s.status === "in_progress" ? "*" : " "}] ${s.id}: ${s.description}`,
        )
      }
      return lines.join("\n")
    }
    default:
      return `Unknown plan action: ${options.action}`
  }
}

export function listPlans(): Plan[] {
  return listPlanFiles()
    .map((id) => loadPlan(id))
    .filter((p): p is Plan => p !== undefined)
}
