/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { useHandlePlanClick } from "./use-handle-plan-click.js"

/**
 * The "hook" is a plain dispatcher: clicking a plan in the planner fires a
 * `nemo:plan` CustomEvent that the host shell listens for. The
 * `typeof window` guard makes it safe to call during SSR/Node rendering.
 */
const dispatched: CustomEvent[] = []

const stubWindow = (): void => {
  ;(globalThis as Record<string, unknown>).window = {
    dispatchEvent: (event: CustomEvent) => {
      dispatched.push(event)
      return true
    },
  }
}

const dropWindow = (): void => {
  delete (globalThis as Record<string, unknown>).window
}

beforeEach(() => {
  dispatched.length = 0
  stubWindow()
})

afterEach(dropWindow)

describe("useHandlePlanClick", () => {
  it("dispatches nemo:plan carrying the clicked plan name", () => {
    useHandlePlanClick().handlePlanClick("release-checklist.md")
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]!.type).toBe("nemo:plan")
    expect(dispatched[0]!.detail).toEqual({ planName: "release-checklist.md" })
  })

  it("dispatches exactly one event per click", () => {
    const { handlePlanClick } = useHandlePlanClick()
    handlePlanClick("a.md")
    handlePlanClick("b.md")
    expect(dispatched.map((event) => event.detail.planName)).toEqual(["a.md", "b.md"])
  })

  it("is a silent no-op without a window (non-DOM runtime)", () => {
    dropWindow()
    expect(() => useHandlePlanClick().handlePlanClick("plan.md")).not.toThrow()
    expect(dispatched).toHaveLength(0)
  })
})
