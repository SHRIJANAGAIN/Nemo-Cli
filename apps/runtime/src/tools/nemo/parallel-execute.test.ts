/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, vi } from "vitest"
import { createParallelExecuteTool } from "./parallel-execute.js"

function bodyOf(result: { content: Array<{ text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join()
}

describe("createParallelExecuteTool", () => {
  it("exposes the ParallelExecute identity", () => {
    const tool = createParallelExecuteTool(vi.fn())

    expect(tool.definition.name).toBe("nemo__ParallelExecute")
    expect(tool.definition.timeoutMs).toBe(30_000)
  })

  it("says honestly when no runner is wired — never fake success", async () => {
    const tool = createParallelExecuteTool(undefined)
    const result = await tool.execute(
      "t1",
      { plan: "ship it", taskType: "fullstack" },
      undefined,
      undefined,
      undefined as never,
    )

    expect(result.isError).toBe(true)
    expect(bodyOf(result)).toContain("Team runner is unavailable")
  })

  it("rejects a missing plan", async () => {
    const tool = createParallelExecuteTool(vi.fn())
    const result = await tool.execute("t1", { plan: "  " }, undefined, undefined, undefined as never)

    expect(result.isError).toBe(true)
    expect(bodyOf(result)).toContain("Missing required parameter: plan")
  })

  it("fans fullstack work to frontend and backend specialists", async () => {
    const seen: Array<{ name: string }> = []
    const run = vi.fn(async (tasks: Array<{ name: string; prompt: string; subagentType?: string }>) => {
      seen.push(...tasks)
      return [
        { name: "Frontend Specialist", text: "ui ready" },
        { name: "Backend Specialist", text: "api ready" },
      ]
    })
    const tool = createParallelExecuteTool(run)
    const result = await tool.execute(
      "t1",
      { plan: "add login", taskType: "fullstack", targetFiles: ["a.ts"] },
      undefined,
      undefined,
      undefined as never,
    )

    expect(result.isError).toBe(false)
    expect(run).toHaveBeenCalledOnce()
    expect(seen.map((t) => t.name)).toEqual(["Frontend Specialist", "Backend Specialist"])
    expect(bodyOf(result)).toContain("ui ready")
    expect(bodyOf(result)).toContain("api ready")
  })

  it("routes audit work to quality and security specialists and flags failures", async () => {
    const run = vi.fn(async () => [
      { name: "Code Quality Auditor", text: "logic ok" },
      { name: "Security Auditor", text: "", error: "timed out" },
    ])
    const tool = createParallelExecuteTool(run)
    const result = await tool.execute(
      "t1",
      { plan: "audit auth", taskType: "audit" },
      undefined,
      undefined,
      undefined as never,
    )

    expect(result.isError).toBe(false)
    expect(bodyOf(result)).toContain("logic ok")
    expect(bodyOf(result)).toContain("Execution failed: timed out")
  })
})
