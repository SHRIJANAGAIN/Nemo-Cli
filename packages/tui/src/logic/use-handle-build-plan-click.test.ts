/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { useHandleBuildPlanClick } from "./use-handle-build-plan-click.js"

/**
 * The build-plan dispatcher fires `nemo:build-plan` for the host shell.
 * It accepts the originating click for call-site convenience but must NOT
 * forward it — listeners get a bare event.
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

describe("useHandleBuildPlanClick", () => {
  it("dispatches nemo:build-plan with no detail payload", () => {
    useHandleBuildPlanClick().handleBuildPlanClick()
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]!.type).toBe("nemo:build-plan")
    expect(dispatched[0]!.detail ?? null).toBeNull()
  })

  it("ignores the optional mouse event it is handed", () => {
    const fakeClick = { type: "click", currentTarget: {} } as unknown as React.MouseEvent<HTMLButtonElement>
    useHandleBuildPlanClick().handleBuildPlanClick(fakeClick)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]!.type).toBe("nemo:build-plan")
    expect(dispatched[0]!.detail ?? null).toBeNull()
  })

  it("is a silent no-op without a window (non-DOM runtime)", () => {
    dropWindow()
    expect(() => useHandleBuildPlanClick().handleBuildPlanClick()).not.toThrow()
    expect(dispatched).toHaveLength(0)
  })
})
