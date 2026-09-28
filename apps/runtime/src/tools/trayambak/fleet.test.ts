/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, vi } from "vitest"
import { createFleetTool, fleetListText, fleetPeekText, type FleetJob } from "./fleet.js"

const jobs: FleetJob[] = [
  { id: "a1", name: "lint audit", status: "running", startedAt: 1 },
  { id: "b2", name: "tests", status: "completed", startedAt: 2, output: "ok" },
  { id: "c3", name: "deploy", status: "error", startedAt: 3, error: "boom" },
]

describe("fleetListText", () => {
  it("groups by state and is honest when empty", () => {
    const text = fleetListText(jobs)
    expect(text).toContain("Working:")
    expect(text).toContain("Done:")
    expect(text).toContain("Needs input:")
    expect(fleetListText([])).toContain("no background sessions")
  })
})

describe("fleetPeekText", () => {
  it("peeks output and reports unknown ids", () => {
    expect(fleetPeekText(jobs, "b2")).toContain("ok")
    expect(fleetPeekText(jobs, "nope")).toContain("no job matches")
  })
})

describe("createFleetTool", () => {
  it("exposes timeoutMs and needs a registry", async () => {
    const tool = createFleetTool(undefined)
    expect(tool.definition.timeoutMs).toBe(30_000)
    const r = await tool.execute("t1", { action: "list" }, undefined, undefined, undefined as never)
    expect(r.isError).toBe(true)
  })

  it("lists and peeks via the injected lister", async () => {
    const tool = createFleetTool(vi.fn(() => jobs))
    const list = await tool.execute("t1", { action: "list" }, undefined, undefined, undefined as never)
    expect(list.isError).toBe(false)
    const peek = await tool.execute("t1", { action: "peek", id: "a1" }, undefined, undefined, undefined as never)
    expect(peek.isError).toBe(false)
    const bad = await tool.execute("t1", { action: "peek" }, undefined, undefined, undefined as never)
    expect(bad.isError).toBe(true)
  })
})
