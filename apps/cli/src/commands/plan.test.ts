/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type * as PlanModule from "./plan.js"

/**
 * plan.ts resolves its storage root from os.homedir() AT MODULE LOAD, so the
 * temp home is installed before the dynamic import in beforeAll — the real
 * ~/.trayambak/plans is never touched. `import type` is erased at runtime.
 */

let plan: typeof PlanModule
let home = ""
let savedUserprofile: string | undefined
let savedHome: string | undefined

const planDir = (): string => path.join(home, ".trayambak", "plans")

const planFile = (id: string): string => path.join(planDir(), `${id}.json`)

interface StoredPlan {
  id: string
  name: string
  description: string
  status: string
  steps: Array<{ id: string; description: string; status: string }>
}

function readPlan(id: string): StoredPlan {
  return JSON.parse(fs.readFileSync(planFile(id), "utf8")) as StoredPlan
}

/** Create a plan and hand back the generated id (plan-<base36 ts>). */
function createPlan(name: string, description?: string): string {
  const out = plan.planCommand({ action: "create", name, description })
  const match = /^Created plan (plan-[a-z0-9]+): /.exec(out)
  if (!match) throw new Error(`unexpected create output: ${out}`)
  return match[1]
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-plan-home-"))
  savedUserprofile = process.env.USERPROFILE
  savedHome = process.env.HOME
  process.env.USERPROFILE = home
  process.env.HOME = home
  plan = await import("./plan.js")
  process.env.USERPROFILE = savedUserprofile
  process.env.HOME = savedHome
})

afterAll(() => {
  try {
    fs.rmSync(home, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

beforeEach(() => {
  fs.rmSync(planDir(), { recursive: true, force: true })
})

describe("planCommand create", () => {
  it("requires a name", () => {
    expect(plan.planCommand({ action: "create" })).toBe("Missing plan name")
    expect(fs.existsSync(planDir())).toBe(false)
  })

  it("persists an active plan with an empty step list", () => {
    const out = plan.planCommand({ action: "create", name: "Refactor", description: "do it" })
    expect(out).toMatch(/^Created plan plan-[a-z0-9]+: Refactor$/)
    const firstId = /^Created plan (plan-[a-z0-9]+): /.exec(out)?.[1] as string

    const stored = readPlan(firstId)
    expect(stored.name).toBe("Refactor")
    expect(stored.description).toBe("do it")
    expect(stored.status).toBe("active")
    expect(stored.steps).toEqual([])

    // A second create gets its own file (ids are timestamp-derived).
    const secondId = createPlan("Second")
    expect(secondId).not.toBe(firstId)
    expect(readPlan(secondId).name).toBe("Second")
  })

  it("defaults the description to an empty string", () => {
    const id = createPlan("NoDesc")
    expect(readPlan(id).description).toBe("")
  })
})

describe("planCommand add-step", () => {
  it("requires a plan id", () => {
    expect(plan.planCommand({ action: "add-step", stepDescription: "x" })).toBe("Missing plan id")
  })

  it("requires a step description", () => {
    const id = createPlan("P")
    expect(plan.planCommand({ action: "add-step", planId: id })).toBe("Missing step description")
  })

  it("reports a plan that does not exist", () => {
    expect(plan.planCommand({ action: "add-step", planId: "plan-missing", stepDescription: "x" })).toBe(
      "Plan not found: plan-missing",
    )
  })

  it("appends a pending step to the stored plan", () => {
    const id = createPlan("P")
    const out = plan.planCommand({
      action: "add-step",
      planId: id,
      stepDescription: "first step",
    })
    expect(out).toMatch(/^Added step step-[a-z0-9]+: first step$/)

    const stored = readPlan(id)
    expect(stored.steps).toHaveLength(1)
    expect(stored.steps[0]).toMatchObject({ description: "first step", status: "pending" })
  })
})

describe("planCommand update-step", () => {
  it("requires both ids", () => {
    expect(plan.planCommand({ action: "update-step" })).toBe("Missing plan id or step id")
    expect(plan.planCommand({ action: "update-step", planId: "p" })).toBe("Missing plan id or step id")
    expect(plan.planCommand({ action: "update-step", stepId: "s" })).toBe("Missing plan id or step id")
  })

  it("reports unknown plan and unknown step distinctly", () => {
    const id = createPlan("P")
    expect(plan.planCommand({ action: "update-step", planId: "plan-missing", stepId: "s" })).toBe(
      "Plan not found: plan-missing",
    )

    expect(plan.planCommand({ action: "update-step", planId: id, stepId: "step-missing" })).toBe(
      "Step not found: step-missing",
    )
  })

  it("persists a status change", () => {
    const id = createPlan("P")
    plan.planCommand({ action: "add-step", planId: id, stepDescription: "growing" })
    const stepId = readPlan(id).steps[0].id

    const out = plan.planCommand({
      action: "update-step",
      planId: id,
      stepId,
      status: "completed",
    })
    expect(out).toBe(`Updated step ${stepId} -> completed`)
    expect(readPlan(id).steps[0].status).toBe("completed")
  })

  it("rewrites the description without touching the status", () => {
    const id = createPlan("P")
    plan.planCommand({ action: "add-step", planId: id, stepDescription: "old" })
    const stepId = readPlan(id).steps[0].id

    plan.planCommand({
      action: "update-step",
      planId: id,
      stepId,
      stepDescription: "new wording",
    })
    expect(readPlan(id).steps[0]).toMatchObject({
      description: "new wording",
      status: "pending",
    })
  })
})

describe("planCommand complete/list/show", () => {
  it("completes an existing plan and reports missing ids", () => {
    expect(plan.planCommand({ action: "complete" })).toBe("Missing plan id")
    expect(plan.planCommand({ action: "complete", planId: "plan-missing" })).toBe("Plan not found: plan-missing")

    const id = createPlan("Ship")
    expect(plan.planCommand({ action: "complete", planId: id })).toBe(`Completed plan ${id}`)
    expect(readPlan(id).status).toBe("completed")
  })

  it("lists nothing when there are no plans", () => {
    expect(plan.planCommand({ action: "list" })).toBe("No plans")
  })

  it("lists each plan as id: name [status] (n steps)", () => {
    const id = createPlan("Alpha", "desc")
    plan.planCommand({ action: "add-step", planId: id, stepDescription: "one" })
    expect(plan.planCommand({ action: "list" })).toBe(`${id}: Alpha [active] (1 steps)`)
  })

  it("skips a corrupt plan file instead of failing the list", () => {
    fs.mkdirSync(planDir(), { recursive: true })
    fs.writeFileSync(planFile("plan-broken"), "{ not json", "utf8")
    const good = createPlan("Survivor")

    // The unreadable file is dropped from both the command output and
    // listPlans(); the parseable plan still lists. (Note: when the ONLY
    // file is corrupt the command returns "" rather than "No plans" —
    // the "No plans" shortcut keys off directory entries, not parsed plans.)
    expect(plan.planCommand({ action: "list" })).toBe(`${good}: Survivor [active] (0 steps)`)
    expect(plan.listPlans().map((p) => p.id)).toEqual([good])

    fs.rmSync(planFile("plan-broken"))
    fs.rmSync(planFile(good))
    expect(plan.planCommand({ action: "list" })).toBe("No plans")
    expect(plan.listPlans()).toEqual([])
  })

  it("renders show with status, description fallback and step markers", () => {
    expect(plan.planCommand({ action: "show" })).toBe("Missing plan id")
    expect(plan.planCommand({ action: "show", planId: "plan-missing" })).toBe("Plan not found: plan-missing")

    const id = createPlan("Showcase")
    plan.planCommand({ action: "add-step", planId: id, stepDescription: "todo step" })
    const stepId = readPlan(id).steps[0].id
    plan.planCommand({ action: "update-step", planId: id, stepId, status: "completed" })

    expect(plan.planCommand({ action: "show", planId: id })).toBe(
      `${id}: Showcase\nStatus: active\nDescription: (none)\nSteps:\n  [x] ${stepId}: todo step`,
    )
  })

  it("listPlans exposes the parsed plans", () => {
    const id = createPlan("Exposed")
    const plans = plan.listPlans()
    expect(plans).toHaveLength(1)
    expect(plans[0].id).toBe(id)
    expect(plans[0].steps).toEqual([])
  })

  it("reports an unknown action", () => {
    expect(plan.planCommand({ action: "juggle" as never })).toBe("Unknown plan action: juggle")
  })
})
