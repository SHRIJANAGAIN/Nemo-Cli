/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, vi } from "vitest"
import { createTeamTool } from "./team.js"

describe("createTeamTool", () => {
  it("exposes timeoutMs and needs a runner", async () => {
    const tool = createTeamTool(undefined)
    expect(tool.definition.timeoutMs).toBe(30_000)
    const r = await tool.execute("t1", { tasks: [{ name: "a", prompt: "do x" }] }, undefined, undefined, undefined as never)
    expect(r.isError).toBe(true)
  })

  it("rejects empty or promptless tasks", async () => {
    const tool = createTeamTool(vi.fn())
    expect((await tool.execute("t1", { tasks: [] }, undefined, undefined, undefined as never)).isError).toBe(true)
    expect(
      (await tool.execute("t1", { tasks: [{ name: "a", prompt: "  " }] }, undefined, undefined, undefined as never)).isError,
    ).toBe(true)
  })

  it("aggregates results and surfaces errors and background starts", async () => {
    const run = vi.fn(async () => [
      { name: "a", text: "done a" },
      { name: "b", text: "", error: "blew up" },
      { name: "c", text: "", background: true, subagentId: "bg1" },
    ])
    const tool = createTeamTool(run)
    const r = await tool.execute(
      "t1",
      { tasks: [{ name: "a", prompt: "x" }, { name: "b", prompt: "y" }, { name: "c", prompt: "z", background: true }] },
      undefined,
      undefined,
      undefined as never,
    )
    expect(r.isError).toBe(false)
    const body = r.content.map((c) => c.text ?? "").join()
    expect(body).toContain("done a")
    expect(body).toContain("ERROR: blew up")
    expect(body).toContain("bg1")
  })
})
