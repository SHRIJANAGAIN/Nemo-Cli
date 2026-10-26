/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { Planner } from "./planner.js"

describe("Planner", () => {
  it("decompose() creates a DRAFT plan with six dependent steps", () => {
    const planner = new Planner()
    const plan = planner.decompose("ship the widget")
    expect(plan.goal).toBe("ship the widget")
    expect(plan.status).toBe("DRAFT")
    expect(plan.currentStepIndex).toBe(0)
    expect(plan.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"])
    expect(plan.steps[0].description).toBe("Analyze requirements for: ship the widget")
    expect(plan.steps.every((s) => s.status === "PENDING")).toBe(true)
    expect(plan.steps[0].dependencies).toEqual([])
    expect(plan.steps[1].dependencies).toEqual(["s1"])
    expect(() => new Date(plan.createdAt).toISOString()).not.toThrow()
    expect(() => new Date(plan.updatedAt).toISOString()).not.toThrow()
  })

  it("approve() refuses before a plan exists and moves DRAFT → APPROVED", () => {
    const planner = new Planner()
    expect(planner.approve()).toBe(false)
    planner.decompose("goal")
    expect(planner.approve()).toBe(true)
    expect(planner.getPlan()?.status).toBe("APPROVED")
  })

  it("getPlan()/getCurrentStep() are null until a plan exists", () => {
    const planner = new Planner()
    expect(planner.getPlan()).toBeNull()
    expect(planner.getCurrentStep()).toBeNull()
    expect(planner.nextStep()).toBeNull()
  })

  it("nextStep() flips the current PENDING step to IN_PROGRESS and returns it", () => {
    const planner = new Planner()
    planner.decompose("goal")
    const step = planner.nextStep()
    expect(step?.id).toBe("s1")
    expect(step?.status).toBe("IN_PROGRESS")
    expect(planner.getCurrentStep()?.id).toBe("s1")
    // A second call returns the same in-progress step without re-triggering.
    expect(planner.nextStep()?.id).toBe("s1")
    expect(planner.getPlan()?.currentStepIndex).toBe(0)
  })

  it("completeCurrentStep() records the actual time and advances", () => {
    const planner = new Planner()
    planner.decompose("goal")
    planner.nextStep()
    planner.completeCurrentStep(120)
    const plan = planner.getPlan()
    expect(plan?.steps[0].status).toBe("COMPLETED")
    expect(plan?.steps[0].actual).toBe(120)
    expect(plan?.currentStepIndex).toBe(1)
    expect(planner.getCurrentStep()?.id).toBe("s2")
  })

  it("completeCurrentStep() leaves actual undefined when not provided", () => {
    const planner = new Planner()
    planner.decompose("goal")
    planner.completeCurrentStep()
    expect(planner.getPlan()?.steps[0].actual).toBeUndefined()
    expect(planner.getPlan()?.currentStepIndex).toBe(1)
  })

  it("failCurrentStep() marks the step FAILED without advancing", () => {
    const planner = new Planner()
    planner.decompose("goal")
    planner.nextStep()
    planner.failCurrentStep()
    expect(planner.getPlan()?.steps[0].status).toBe("FAILED")
    expect(planner.getPlan()?.currentStepIndex).toBe(0)
    // nextStep() only promotes PENDING steps, so the failed step stays put.
    expect(planner.nextStep()?.id).toBe("s1")
    expect(planner.nextStep()?.status).toBe("FAILED")
  })

  it("completing every step flips the plan to COMPLETED and nextStep() then returns null", () => {
    const planner = new Planner()
    planner.decompose("goal")
    for (let i = 0; i < 6; i++) {
      planner.nextStep()
      planner.completeCurrentStep(i)
    }
    const plan = planner.getPlan()
    expect(plan?.status).toBe("COMPLETED")
    expect(plan?.currentStepIndex).toBe(5)
    expect(planner.nextStep()).toBeNull()
    // Completing again on a finished plan stays COMPLETED at the last step.
    planner.completeCurrentStep(99)
    expect(planner.getPlan()?.status).toBe("COMPLETED")
    expect(planner.getPlan()?.currentStepIndex).toBe(5)
    expect(planner.getPlan()?.steps[5].actual).toBe(99)
  })

  it("mutators on an empty planner are no-ops", () => {
    const planner = new Planner()
    planner.completeCurrentStep(5)
    planner.failCurrentStep()
    expect(planner.getPlan()).toBeNull()
  })
})
