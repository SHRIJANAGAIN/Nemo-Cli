/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type * as PlanModule from "./plan.js"
import type { Plan, PlanService } from "./plan.js"

/**
 * plan.ts resolves PLANS_DIR from os.homedir() AT MODULE LOAD, so the temp
 * home is installed before the dynamic import in beforeAll and the real
 * ~/.trayambak/plans.json is never read or written. `import type` above is
 * erased, so it cannot pull the module in early.
 *
 * Ids are `Date.now().toString(36)`-derived, so every test runs under a fake
 * (Date-only) clock. Time is stepped between creations rather than letting
 * two share a millisecond — though create/addStep now disambiguate a collision
 * instead of overwriting (uniqueId), which the same-millisecond tests pin.
 *
 * HOME stays stubbed for the WHOLE suite: the store path is resolved per call
 * (not captured at import), so a restored HOME would send writes to the
 * developer's real ~/.trayambak. afterAll puts the environment back.
 */

let mod: typeof PlanModule
let home = ""
let savedUserprofile: string | undefined
let savedHome: string | undefined
let plansFile = ""

const T0 = new Date("2026-03-01T10:00:00.000Z")

function readStore(): { plans: Array<Record<string, unknown>> } {
  return JSON.parse(fs.readFileSync(plansFile, "utf8")) as { plans: Array<Record<string, unknown>> }
}

function stepTo(time: number): void {
  vi.setSystemTime(time)
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-plan-home-"))
  savedUserprofile = process.env.USERPROFILE
  savedHome = process.env.HOME
  process.env.USERPROFILE = home
  process.env.HOME = home
  mod = await import("./plan.js")
  plansFile = mod.getPlansFilePath()
})

afterAll(() => {
  // Restore only after the suite: the path is resolved per call, so HOME must
  // stay stubbed while tests write.
  process.env.USERPROFILE = savedUserprofile
  process.env.HOME = savedHome
  try {
    fs.rmSync(home, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ["Date"] })
  fs.rmSync(plansFile, { force: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("PlanService.create", () => {
  it("builds an active plan whose id derives from the clock and persists it", () => {
    const svc = new mod.PlanService()
    const plan = svc.create("Ship v2", "Roll out the v2 release")

    expect(plan.id).toBe(`plan-${T0.getTime().toString(36)}`)
    expect(plan.status).toBe("active")
    expect(plan.steps).toEqual([])
    expect(plan.createdAt).toBeInstanceOf(Date)
    expect(plan.updatedAt).toBeInstanceOf(Date)
    expect(svc.getActive()?.id).toBe(plan.id)
    expect(svc.get(plan.id)?.description).toBe("Roll out the v2 release")

    expect(readStore().plans.map((p) => p.id)).toEqual([plan.id])
  })

  it("makes each newly created plan the active plan", () => {
    const svc = new mod.PlanService()
    const first = svc.create("First", "first plan")
    stepTo(T0.getTime() + 60_000)
    const second = svc.create("Second", "second plan")

    expect(svc.getActive()?.id).toBe(second.id)
    expect(svc.getActive()?.id).not.toBe(first.id)
    expect(readStore().plans).toHaveLength(2)
  })

  it("does not overwrite the first plan when two are created in the same millisecond", () => {
    const svc = new mod.PlanService()
    // No clock step between these: Date.now() is identical, and the store is a
    // Map keyed by id — before the disambiguation the second create() replaced
    // the first plan outright (and the caller still held a dangling object).
    const first = svc.create("First", "first plan")
    const second = svc.create("Second", "second plan")

    expect(second.id).not.toBe(first.id)
    expect(svc.get(first.id)?.description).toBe("first plan")
    expect(svc.get(second.id)?.description).toBe("second plan")
    expect(svc.list()).toHaveLength(2)
    expect(
      readStore()
        .plans.map((p) => p.id)
        .sort(),
    ).toEqual([first.id, second.id].sort())
  })

  it("keeps plan steps addressable when two are added in the same millisecond", () => {
    const svc = new mod.PlanService()
    const plan = svc.create("Plan", "steps")
    const a = svc.addStep(plan.id, "step one")
    const b = svc.addStep(plan.id, "step two")

    expect(a?.id).not.toBe(b?.id)
    // updateStep scans by id: with a shared id it patched the wrong row.
    svc.updateStep(plan.id, a?.id ?? "", { status: "completed" })
    const steps = svc.get(plan.id)?.steps ?? []
    expect(steps.find((s) => s.id === a?.id)?.status).toBe("completed")
    expect(steps.find((s) => s.id === b?.id)?.status).toBe("pending")
  })
})

describe("PlanService list/get", () => {
  it("orders plans by updatedAt descending, most recently touched first", () => {
    const svc = new mod.PlanService()
    const a = svc.create("A", "first")
    stepTo(T0.getTime() + 60_000)
    const b = svc.create("B", "second")
    expect(svc.list().map((p) => p.id)).toEqual([b.id, a.id])

    stepTo(T0.getTime() + 120_000)
    svc.addStep(a.id, "revise the plan")
    expect(svc.list().map((p) => p.id)).toEqual([a.id, b.id])
    expect(svc.list()[0]?.updatedAt.getTime()).toBe(T0.getTime() + 120_000)
  })

  it("returns undefined from get() for an unknown plan", () => {
    const svc = new mod.PlanService()
    expect(svc.get("plan-does-not-exist")).toBeUndefined()
    expect(svc.getActive()).toBeUndefined()
  })
})

describe("PlanService steps", () => {
  it("appends a pending step with a clock-derived id and persists the step list", () => {
    const svc = new mod.PlanService()
    const plan = svc.create("Build", "builder plan")
    const step = svc.addStep(plan.id, "build the thing", ["prep"])

    expect(step?.id).toBe(`step-${T0.getTime().toString(36)}`)
    expect(step?.status).toBe("pending")
    expect(step?.dependsOn).toEqual(["prep"])
    expect(svc.get(plan.id)?.steps.map((s) => s.description)).toEqual(["build the thing"])

    const stored = readStore().plans[0] as { steps: Array<{ description: string; status: string }> }
    expect(stored.steps.map((s) => s.description)).toEqual(["build the thing"])
    expect(stored.steps[0]?.status).toBe("pending")
  })

  it("refuses to add a step to an unknown plan", () => {
    const svc = new mod.PlanService()
    expect(svc.addStep("plan-does-not-exist", "orphan step")).toBeUndefined()
  })

  it("merges partial updates onto an existing step and bumps the plan timestamp", () => {
    const svc = new mod.PlanService()
    const plan = svc.create("Work", "working plan")
    const stepId = svc.addStep(plan.id, "do it")?.id ?? ""
    expect(stepId).not.toBe("")

    stepTo(T0.getTime() + 30_000)
    const updated = svc.updateStep(plan.id, stepId, { status: "completed", result: "done" })

    expect(updated?.status).toBe("completed")
    expect(updated?.result).toBe("done")
    expect(updated?.description).toBe("do it")
    expect(svc.get(plan.id)?.updatedAt.getTime()).toBe(T0.getTime() + 30_000)

    const stored = readStore().plans[0] as { steps: Array<{ status: string; result?: string }> }
    expect(stored.steps[0]?.status).toBe("completed")
    expect(stored.steps[0]?.result).toBe("done")
  })

  it("returns undefined when updating a step on an unknown plan or an unknown step", () => {
    const svc = new mod.PlanService()
    const plan = svc.create("P", "d")

    expect(svc.updateStep("plan-does-not-exist", "step-x", { status: "blocked" })).toBeUndefined()
    expect(svc.updateStep(plan.id, "step-does-not-exist", { status: "blocked" })).toBeUndefined()
  })
})

describe("PlanService.complete", () => {
  it("completes a plan, clears it as active, and persists the new status", () => {
    const svc = new mod.PlanService()
    const plan = svc.create("Finish", "finish this")

    expect(svc.complete(plan.id)).toBe(true)
    expect(svc.get(plan.id)?.status).toBe("completed")
    expect(svc.getActive()).toBeUndefined()
    expect(svc.complete("plan-does-not-exist")).toBe(false)

    const reloaded = new mod.PlanService()
    expect(reloaded.get(plan.id)?.status).toBe("completed")
    expect(reloaded.getActive()).toBeUndefined()
  })
})

describe("PlanService store round-trip", () => {
  it("rehydrates persisted plans as a fresh service with Date instances and the active plan restored", () => {
    const first = new mod.PlanService()
    const plan = first.create("Persisted", "survives restart")
    first.addStep(plan.id, "step one")

    const second = new mod.PlanService()
    const rehydrated: Plan | undefined = second.get(plan.id)

    expect(rehydrated?.createdAt).toBeInstanceOf(Date)
    expect(rehydrated?.updatedAt).toBeInstanceOf(Date)
    expect(rehydrated?.createdAt.getTime()).toBe(plan.createdAt.getTime())
    expect(rehydrated?.steps.map((s) => s.description)).toEqual(["step one"])
    expect(second.getActive()?.id).toBe(plan.id)
    expect(second.list().map((p) => p.id)).toEqual([plan.id])
  })

  it("does not adopt a stored completed plan as the active plan", () => {
    fs.mkdirSync(path.dirname(plansFile), { recursive: true })
    fs.writeFileSync(
      plansFile,
      JSON.stringify({
        plans: [
          {
            id: "plan-closed",
            name: "Closed",
            description: "already done",
            steps: [],
            status: "completed",
            createdAt: T0.toISOString(),
            updatedAt: T0.toISOString(),
          },
        ],
      }),
      "utf8",
    )

    const svc = new mod.PlanService()
    expect(svc.getActive()).toBeUndefined()
    expect(svc.list().map((p) => p.id)).toEqual(["plan-closed"])
  })

  it("starts empty instead of throwing when the store file is corrupt", () => {
    fs.mkdirSync(path.dirname(plansFile), { recursive: true })
    fs.writeFileSync(plansFile, "{ this is not json", "utf8")

    let svc: PlanService | undefined
    expect(() => {
      svc = new mod.PlanService()
    }).not.toThrow()
    expect(svc?.list()).toEqual([])
    expect(svc?.getActive()).toBeUndefined()
  })

  it("starts empty when no store file exists yet", () => {
    const svc = new mod.PlanService()
    expect(svc.list()).toEqual([])
  })
})

describe("plan storage location", () => {
  it("resolves the plans file under the module's home, not the working directory", () => {
    expect(mod.getPlansFilePath()).toBe(path.join(home, ".trayambak", "plans.json"))
    expect(path.dirname(mod.getPlansFilePath())).toBe(path.join(home, ".trayambak"))
    expect(path.resolve(home).startsWith(path.resolve(process.cwd()))).toBe(false)
  })
})

describe("planService singleton", () => {
  it("starts empty and persists plans it creates to the store", () => {
    expect(mod.planService.list()).toEqual([])

    const plan = mod.planService.create("Singleton plan", "created via the module export")
    expect(mod.planService.getActive()?.id).toBe(plan.id)
    expect(readStore().plans.map((p) => p.id)).toEqual([plan.id])
  })
})
