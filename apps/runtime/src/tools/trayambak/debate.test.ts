/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it, vi } from "vitest"
import { buildDebateTasks, createDebateTool, synthesizeDebate } from "./debate.js"

describe("buildDebateTasks", () => {
  it("assigns one hypothesis per teammate with disproof targets", () => {
    const tasks = buildDebateTasks("app exits after one message", ["event loop ends", "socket closed"])
    expect(tasks).toHaveLength(2)
    expect(tasks[0]?.prompt).toContain("event loop ends")
    expect(tasks[0]?.prompt).toContain("socket closed")
    expect(tasks[1]?.prompt).toContain("socket closed")
  })

  it("caps at five teammates and respects file boundaries", () => {
    const hyps = ["a", "b", "c", "d", "e", "f", "g"]
    const tasks = buildDebateTasks("t", hyps, { files: [["x.ts"], ["y.ts"], ["z.ts"], ["w.ts"], ["v.ts"]] })
    expect(tasks).toHaveLength(5)
    expect(tasks[0]?.prompt).toContain("x.ts")
    expect(tasks[0]?.prompt).not.toContain("y.ts")
  })
})

describe("synthesizeDebate", () => {
  it("keeps every verdict and flags errored teammates", () => {
    const text = synthesizeDebate("t", [
      { name: "t1", text: "SUPPORTED: logs prove it" },
      { name: "t2", error: "timeout" },
    ])
    expect(text).toContain("SUPPORTED")
    expect(text).toContain("ERROR: timeout")
  })
})

describe("createDebateTool", () => {
  it("exposes timeoutMs and rejects too few hypotheses", async () => {
    const tool = createDebateTool(vi.fn())
    expect(tool.definition.timeoutMs).toBe(120_000)
    const r = await tool.execute(
      "t1",
      { topic: "t", hypotheses: ["only one"] },
      undefined,
      undefined,
      undefined as never,
    )
    expect(r.isError).toBe(true)
  })

  it("says honestly when no runner is wired", async () => {
    const tool = createDebateTool(undefined)
    const r = await tool.execute("t1", { topic: "t", hypotheses: ["a", "b"] }, undefined, undefined, undefined as never)
    expect(r.isError).toBe(true)
  })

  it("runs rival hypotheses and synthesizes", async () => {
    const run = vi.fn(async () => [
      { name: "debate-teammate-1", text: "DISPROVEN by test X" },
      { name: "debate-teammate-2", text: "SUPPORTED by log Y" },
    ])
    const tool = createDebateTool(run)
    const r = await tool.execute(
      "t1",
      { topic: "flaky test", hypotheses: ["race", "seed"] },
      undefined,
      undefined,
      undefined as never,
    )
    expect(r.isError).toBe(false)
    expect(run).toHaveBeenCalledOnce()
    const body = r.content.map((c) => c.text ?? "").join()
    expect(body).toContain("DISPROVEN")
    expect(body).toContain("SUPPORTED")
  })
})
