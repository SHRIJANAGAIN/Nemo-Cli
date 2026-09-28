/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

export * as TrayambakPlan from "./plan"

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

export interface PlanStep {
  readonly id: string
  readonly description: string
  readonly status: "pending" | "in_progress" | "completed" | "blocked"
  readonly result?: string
  readonly dependsOn?: string[]
}

export interface Plan {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly steps: PlanStep[]
  readonly status: "active" | "completed" | "abandoned"
  readonly createdAt: Date
  readonly updatedAt: Date
}

const PLANS_DIR = path.join(os.homedir(), ".trayambak")
const PLANS_FILE = path.join(PLANS_DIR, "plans.json")

interface PlanStore {
  plans: Plan[]
}

function loadStore(): PlanStore {
  try {
    if (fs.existsSync(PLANS_FILE)) {
      return JSON.parse(fs.readFileSync(PLANS_FILE, "utf8")) as PlanStore
    }
  } catch {
    /* fall through */
  }
  return { plans: [] }
}

function saveStore(store: PlanStore): void {
  fs.mkdirSync(PLANS_DIR, { recursive: true })
  fs.writeFileSync(PLANS_FILE, JSON.stringify(store, null, 2), "utf8")
}

export class PlanService {
  private plans: Map<string, Plan> = new Map()
  private activePlan?: Plan

  constructor() {
    const store = loadStore()
    for (const p of store.plans) {
      this.plans.set(p.id, { ...p, createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt) })
    }
    const active = store.plans.find((p) => p.status === "active")
    if (active) this.activePlan = this.plans.get(active.id)
  }

  private persist(): void {
    const store: PlanStore = {
      plans: Array.from(this.plans.values()).map((p) => ({
        ...p,
        createdAt: p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt),
        updatedAt: p.updatedAt instanceof Date ? p.updatedAt : new Date(p.updatedAt),
      })),
    }
    saveStore(store)
  }

  create(name: string, description: string): Plan {
    const plan: Plan = {
      id: `plan-${Date.now().toString(36)}`,
      name,
      description,
      steps: [],
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    this.plans.set(plan.id, plan)
    this.activePlan = plan
    this.persist()
    return plan
  }

  getActive(): Plan | undefined {
    return this.activePlan
  }

  get(id: string): Plan | undefined {
    return this.plans.get(id)
  }

  addStep(planId: string, description: string, dependsOn?: string[]): PlanStep | undefined {
    const plan = this.plans.get(planId)
    if (!plan) return undefined

    const step: PlanStep = {
      id: `step-${Date.now().toString(36)}`,
      description,
      status: "pending",
      dependsOn,
    }

    const updated: Plan = {
      ...plan,
      steps: [...plan.steps, step],
      updatedAt: new Date(),
    }
    this.plans.set(planId, updated)
    this.persist()

    return step
  }

  updateStep(planId: string, stepId: string, updates: Partial<PlanStep>): PlanStep | undefined {
    const plan = this.plans.get(planId)
    if (!plan) return undefined

    const steps = plan.steps.map((s) => (s.id === stepId ? { ...s, ...updates } : s))
    const updated: Plan = { ...plan, steps, updatedAt: new Date() }
    this.plans.set(planId, updated)
    this.persist()

    return steps.find((s) => s.id === stepId)
  }

  complete(planId: string): boolean {
    const plan = this.plans.get(planId)
    if (!plan) return false

    const updated: Plan = { ...plan, status: "completed", updatedAt: new Date() }
    this.plans.set(planId, updated)
    if (this.activePlan?.id === planId) {
      this.activePlan = undefined
    }
    this.persist()
    return true
  }

  list(): Plan[] {
    return Array.from(this.plans.values()).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  }
}

export const planService = new PlanService()

export function getPlansFilePath(): string {
  return PLANS_FILE
}
