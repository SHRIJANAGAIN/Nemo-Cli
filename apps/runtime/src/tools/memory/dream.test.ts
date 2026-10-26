/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import {
  DREAM_MAX_BYTES,
  DREAM_MAX_ENTRIES,
  createDreamTool,
  planDreamConsolidation,
  runDreamConsolidation,
} from "./dream.js"
import type { MemoryEntry } from "./memory.js"

function entry(id: string, content: string, extra?: Partial<MemoryEntry>): MemoryEntry {
  return {
    id,
    content,
    category: "context",
    timestamp: new Date().toISOString(),
    tags: [],
    createdAt: new Date().toISOString(),
    ...extra,
  }
}

describe("planDreamConsolidation", () => {
  it("drops exact duplicates keeping the first", () => {
    const plan = planDreamConsolidation([
      entry("a", "I use pwsh on Windows"),
      entry("b", "  i USE   pwsh on windows  "),
      entry("c", "Something else"),
    ])
    expect(plan.dropDupeIds).toEqual(["b"])
    expect(plan.keep.map((e) => e.id)).toEqual(["a", "c"])
  })

  it("drops expired frontmatter entries", () => {
    const plan = planDreamConsolidation(
      [
        entry("old", "Stale fact", { frontmatter: { expires: "2020-01-01T00:00:00Z" } }),
        entry("fresh", "Live fact", { frontmatter: { expires: "2099-01-01T00:00:00Z" } }),
      ],
      Date.parse("2026-01-01T00:00:00Z"),
    )
    expect(plan.dropExpiredIds).toEqual(["old"])
    expect(plan.keep.map((e) => e.id)).toEqual(["fresh"])
  })

  it("flags contradictions without auto-deleting", () => {
    const plan = planDreamConsolidation([
      entry("a", "Deploy day is Friday morning", { category: "decision" }),
      entry("b", "Deploy day is Tuesday night", { category: "decision" }),
    ])
    expect(plan.contradictions.length).toBe(1)
    expect(plan.keep.map((e) => e.id)).toEqual(["a", "b"])
  })

  it("flags relative dates for hand resolution", () => {
    const plan = planDreamConsolidation([entry("a", "Release is today at noon")])
    expect(plan.relativeDateIds).toEqual(["a"])
    expect(plan.keep.length).toBe(1)
  })

  it("enforces the entry cap keeping newest", () => {
    const entries = Array.from({ length: DREAM_MAX_ENTRIES + 5 }, (_, i) =>
      entry(`m${i}`, `f${i}`, { timestamp: new Date(Date.UTC(2026, 0, i + 1)).toISOString() }),
    )
    const plan = planDreamConsolidation(entries)
    expect(plan.capped).toBeGreaterThanOrEqual(5)
    expect(plan.keep.length).toBe(DREAM_MAX_ENTRIES)
    expect(plan.keep.at(-1)?.id).toBe(`m${DREAM_MAX_ENTRIES + 4}`)
  })

  it("enforces the byte cap", () => {
    const big = "x".repeat(2000)
    const entries = Array.from({ length: 60 }, (_, i) => entry(`m${i}`, `${big} ${i}`))
    const plan = planDreamConsolidation(entries)
    const used = plan.keep.reduce((n, e) => n + Buffer.byteLength(e.content, "utf8") + 64, 0)
    expect(used).toBeLessThanOrEqual(DREAM_MAX_BYTES)
  })
})

describe("createDreamTool", () => {
  it("exposes timeoutMs and rejects unknown actions", async () => {
    const tool = createDreamTool()
    expect(tool.definition.timeoutMs).toBe(60_000)
    const bad = await tool.execute("t1", { action: "nap" }, undefined, undefined, undefined as never)
    expect(bad.isError).toBe(true)
  })

  it("status never throws", async () => {
    const tool = createDreamTool()
    const r = await tool.execute("t1", { action: "status" }, undefined, undefined, undefined as never)
    expect(r.isError).toBe(false)
  })

  it("runDreamConsolidation never throws", () => {
    expect(() => runDreamConsolidation()).not.toThrow()
  })
})
