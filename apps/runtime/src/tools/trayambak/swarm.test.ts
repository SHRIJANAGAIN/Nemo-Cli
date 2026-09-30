/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it, vi } from "vitest"
import { buildSwarmWorkers, createSwarmTool, synthesizeSwarm, SWARM_MAX_WORKERS, SWARM_MAX_VOTERS } from "./swarm.js"

function bodyOf(result: { content: Array<{ text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join()
}

describe("buildSwarmWorkers", () => {
  it("fans explicit tasks out with their own specialist profiles", () => {
    const workers = buildSwarmWorkers(
      "ship it",
      "fanout",
      [
        { name: "fe", prompt: "build ui", subagentType: "react-reviewer" },
        { name: "be", prompt: "build api" },
      ],
      0,
      "general",
    )

    expect(workers).toHaveLength(2)
    expect(workers[0]?.subagentType).toBe("react-reviewer")
    expect(workers[1]?.subagentType).toBe("general")
  })

  it("caps fanout at eight workers", () => {
    const tasks = Array.from({ length: 20 }, (_, i) => ({ name: `w${i}`, prompt: `do ${i}` }))
    // normalizeTasks caps inside the tool; the builder maps what it is given.
    const workers = buildSwarmWorkers("g", "fanout", tasks.slice(0, SWARM_MAX_WORKERS), 0, "general")

    expect(workers).toHaveLength(SWARM_MAX_WORKERS)
  })

  it("expands a vote into independent voters", () => {
    const workers = buildSwarmWorkers("is it a race?", "vote", [], 3, "general")

    expect(workers).toHaveLength(3)
    expect(workers[0]?.name).toBe("swarm-voter-1")
    expect(workers[0]?.prompt).toContain("voter 1 of 3")
    expect(workers[0]?.prompt).toContain("ANSWER:")
  })

  it("clamps voters to the 2-7 band", () => {
    expect(buildSwarmWorkers("g", "vote", [], 99, "general")).toHaveLength(SWARM_MAX_VOTERS)
    expect(buildSwarmWorkers("g", "vote", [], 0, "general")).toHaveLength(2)
  })
})

describe("synthesizeSwarm", () => {
  it("keeps every worker and flags failures with a synthesis guide", () => {
    const text = synthesizeSwarm("g", "fanout", [
      { name: "w1", text: "ui done" },
      { name: "w2", error: "timeout" },
    ])

    expect(text).toContain("SKT Swarm report (fanout)")
    expect(text).toContain("ui done")
    expect(text).toContain("ERROR: timeout")
    expect(text).toContain("Workers heard: 1/2")
    expect(text).toContain("Synthesis")
  })

  it("guides majority verdicts for votes", () => {
    const text = synthesizeSwarm("g", "vote", [
      { name: "swarm-voter-1", text: "ANSWER: race" },
      { name: "swarm-voter-2", text: "ANSWER: race" },
    ])

    expect(text).toContain("majority verdict")
  })
})

describe("createSwarmTool", () => {
  it("exposes the skt__Swarm identity with a fan-out timeout", () => {
    const tool = createSwarmTool(vi.fn())

    expect(tool.definition.name).toBe("skt__Swarm")
    expect(tool.definition.timeoutMs).toBe(120_000)
  })

  it("says honestly when no runner is wired", async () => {
    const tool = createSwarmTool(undefined)
    const r = await tool.execute("t1", { goal: "g" }, undefined, undefined, undefined as never)

    expect(r.isError).toBe(true)
  })

  it("rejects a missing goal and an unknown strategy", async () => {
    const tool = createSwarmTool(vi.fn())

    const missing = await tool.execute("t1", {}, undefined, undefined, undefined as never)
    expect(missing.isError).toBe(true)
    expect(bodyOf(missing)).toContain("goal")

    const bad = await tool.execute(
      "t1",
      { goal: "g", strategy: "teleport", tasks: [{ name: "w", prompt: "p" }] },
      undefined,
      undefined,
      undefined as never,
    )
    expect(bad.isError).toBe(true)
  })

  it("demands explicit subtasks for fanout (the model decomposes, the swarm executes)", async () => {
    const tool = createSwarmTool(vi.fn())
    const r = await tool.execute("t1", { goal: "g", strategy: "fanout" }, undefined, undefined, undefined as never)

    expect(r.isError).toBe(true)
    expect(bodyOf(r)).toContain("decompose the goal")
  })

  it("runs fanout subtasks and synthesizes the report", async () => {
    const run = vi.fn(async () => [
      { name: "fe", text: "ui prototype ready" },
      { name: "be", text: "api contract ready" },
    ])
    const tool = createSwarmTool(run)
    const r = await tool.execute(
      "t1",
      {
        goal: "ship feature",
        strategy: "fanout",
        tasks: [
          { name: "fe", prompt: "build ui" },
          { name: "be", prompt: "build api" },
        ],
      },
      undefined,
      undefined,
      undefined as never,
    )

    expect(r.isError).toBe(false)
    expect(run).toHaveBeenCalledOnce()
    const body = bodyOf(r)
    expect(body).toContain("ui prototype ready")
    expect(body).toContain("api contract ready")
    expect(body).toContain("Synthesis")
  })

  it("honors the concurrency cap by batching", async () => {
    const batches: number[] = []
    const run = vi.fn(async (tasks: Array<{ name: string }>) => {
      batches.push(tasks.length)
      return tasks.map((t) => ({ name: t.name, text: "ok" }))
    })
    const tool = createSwarmTool(run)
    const tasks = Array.from({ length: 5 }, (_, i) => ({ name: `w${i}`, prompt: `do ${i}` }))
    const r = await tool.execute(
      "t1",
      { goal: "g", strategy: "fanout", tasks, concurrency: 2 },
      undefined,
      undefined,
      undefined as never,
    )

    expect(r.isError).toBe(false)
    expect(batches).toEqual([2, 2, 1])
  })

  it("chains prior outputs through a pipeline in order", async () => {
    const seen: string[] = []
    const run = vi.fn(async (tasks: Array<{ name: string; prompt: string }>) => {
      seen.push(tasks[0]?.prompt ?? "")
      return [{ name: tasks[0]?.name ?? "?", text: `out-for-${tasks[0]?.name}` }]
    })
    const tool = createSwarmTool(run)
    const r = await tool.execute(
      "t1",
      {
        goal: "g",
        strategy: "pipeline",
        tasks: [
          { name: "step1", prompt: "first" },
          { name: "step2", prompt: "second" },
        ],
      },
      undefined,
      undefined,
      undefined as never,
    )

    expect(r.isError).toBe(false)
    expect(run).toHaveBeenCalledTimes(2) // serial, one per step
    expect(seen[1]).toContain("out-for-step1") // second step saw the first output
    expect(bodyOf(r)).toContain("out-for-step2")
  })

  it("runs independent voters and reports the majority guide", async () => {
    const run = vi.fn(async (tasks: Array<{ name: string }>) =>
      tasks.map((t) => ({ name: t.name, text: "ANSWER: race" })),
    )
    const tool = createSwarmTool(run)
    const r = await tool.execute(
      "t1",
      { goal: "is it a race?", strategy: "vote", workers: 3 },
      undefined,
      undefined,
      undefined as never,
    )

    expect(r.isError).toBe(false)
    expect(run).toHaveBeenCalledOnce()
    const body = bodyOf(r)
    expect(body).toContain("ANSWER: race")
    expect(body).toContain("majority verdict")
  })

  it("rejects a single-voter vote", async () => {
    const tool = createSwarmTool(vi.fn())
    const r = await tool.execute(
      "t1",
      { goal: "g", strategy: "vote", workers: 1 },
      undefined,
      undefined,
      undefined as never,
    )

    expect(r.isError).toBe(true)
  })

  it("surfaces worker errors without dropping the other workers", async () => {
    const run = vi.fn(async () => [
      { name: "w1", text: "fine" },
      { name: "w2", text: "", error: "boom" },
    ])
    const tool = createSwarmTool(run)
    const r = await tool.execute(
      "t1",
      {
        goal: "g",
        tasks: [
          { name: "w1", prompt: "a" },
          { name: "w2", prompt: "b" },
        ],
      },
      undefined,
      undefined,
      undefined as never,
    )

    expect(r.isError).toBe(false)
    const body = bodyOf(r)
    expect(body).toContain("fine")
    expect(body).toContain("ERROR: boom")
  })
})
