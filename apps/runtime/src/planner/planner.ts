/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

export interface Step {
  id: string
  description: string
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED"
  dependencies: string[]
  estimate: number
  actual?: number
}

export interface Plan {
  goal: string
  steps: Step[]
  currentStepIndex: number
  status: "DRAFT" | "APPROVED" | "EXECUTING" | "COMPLETED" | "ABANDONED"
  createdAt: string
  updatedAt: string
}

export class Planner {
  private plan: Plan | null = null

  decompose(goal: string): Plan {
    const steps = this.generateSteps(goal)
    this.plan = {
      goal,
      steps,
      currentStepIndex: 0,
      status: "DRAFT",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    return this.plan
  }

  approve(): boolean {
    if (!this.plan) return false
    this.plan.status = "APPROVED"
    this.plan.updatedAt = new Date().toISOString()
    return true
  }

  nextStep(): Step | null {
    if (!this.plan || this.plan.status === "COMPLETED") return null
    const step = this.plan.steps[this.plan.currentStepIndex]
    if (step && step.status === "PENDING") {
      step.status = "IN_PROGRESS"
      this.plan.updatedAt = new Date().toISOString()
    }
    return step ?? null
  }

  completeCurrentStep(actual?: number): void {
    if (!this.plan) return
    const step = this.plan.steps[this.plan.currentStepIndex]
    if (step) {
      step.status = "COMPLETED"
      if (actual !== undefined) step.actual = actual
    }
    this.advance()
  }

  failCurrentStep(): void {
    if (!this.plan) return
    const step = this.plan.steps[this.plan.currentStepIndex]
    if (step) step.status = "FAILED"
    this.plan.updatedAt = new Date().toISOString()
  }

  getCurrentStep(): Step | null {
    if (!this.plan) return null
    return this.plan.steps[this.plan.currentStepIndex] ?? null
  }

  getPlan(): Plan | null {
    return this.plan
  }

  private generateSteps(goal: string): Step[] {
    return [
      {
        id: "s1",
        description: `Analyze requirements for: ${goal}`,
        status: "PENDING",
        dependencies: [],
        estimate: 300,
      },
      {
        id: "s2",
        description: "Research existing codebase and APIs",
        status: "PENDING",
        dependencies: ["s1"],
        estimate: 600,
      },
      { id: "s3", description: "Design solution architecture", status: "PENDING", dependencies: ["s2"], estimate: 400 },
      {
        id: "s4",
        description: "Implement core functionality",
        status: "PENDING",
        dependencies: ["s3"],
        estimate: 1200,
      },
      { id: "s5", description: "Add tests and validation", status: "PENDING", dependencies: ["s4"], estimate: 600 },
      { id: "s6", description: "Review and refine", status: "PENDING", dependencies: ["s5"], estimate: 300 },
    ]
  }

  private advance(): void {
    if (!this.plan) return
    const nextIndex = this.plan.currentStepIndex + 1
    if (nextIndex < this.plan.steps.length) {
      this.plan.currentStepIndex = nextIndex
      this.plan.updatedAt = new Date().toISOString()
    } else {
      this.plan.status = "COMPLETED"
      this.plan.updatedAt = new Date().toISOString()
    }
  }
}
