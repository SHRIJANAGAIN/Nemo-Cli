/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { BASELINE_TOKENS, buildMcpRows, capItems, contextUsage, formatTodoLine, hasOpenTodos } from "./sidebar-data.js"

describe("contextUsage", () => {
  it("computes the used percentage", () => {
    expect(contextUsage(32_000, 128_000).percent).toBe(25)
    // (32k - 12k reserve) / (128k - 12k) — the reserve is not user-usable room.
    expect(contextUsage(32_000, 128_000).usableFraction).toBeCloseTo(20_000 / 116_000, 10)
  })

  it("caps at 100% when tokens exceed the window", () => {
    expect(contextUsage(200_000, 128_000).percent).toBe(100)
  })

  it("returns null percent for an unknown window", () => {
    expect(contextUsage(1_000, undefined)).toEqual({ tokens: 1_000, percent: null, usableFraction: null })
    expect(contextUsage(1_000, 0).percent).toBeNull()
  })

  it("clamps negative / NaN input to zero tokens", () => {
    expect(contextUsage(-5).tokens).toBe(0)
    expect(contextUsage(Number.NaN).tokens).toBe(0)
  })

  // The bar measures the room the user can still spend, so turn-zero context —
  // system prompt, tool schemas, AGENTS.md — must not read as usage.
  it("holds the usable slice at zero until the baseline reserve is spent", () => {
    expect(contextUsage(BASELINE_TOKENS, 128_000).usableFraction).toBe(0)
    expect(contextUsage(6_000, 128_000).usableFraction).toBe(0)
    expect(contextUsage(128_000, 128_000).usableFraction).toBe(1)
  })

  it("has no usable slice when the window is at or under the reserve", () => {
    expect(contextUsage(5_000, BASELINE_TOKENS).usableFraction).toBeNull()
    expect(contextUsage(5_000, 8_000).usableFraction).toBeNull()
  })
})

describe("capItems", () => {
  it("passes through short lists", () => {
    expect(capItems(["a", "b"], 5)).toEqual({ shown: ["a", "b"], hidden: 0 })
  })

  it("trims long lists and counts the hidden rows", () => {
    expect(capItems([1, 2, 3, 4], 2)).toEqual({ shown: [1, 2], hidden: 2 })
  })
})

describe("buildMcpRows", () => {
  it("maps http urls and stdio commands", () => {
    const rows = buildMcpRows({
      docs: { url: "https://example.com/mcp" },
      fs: { command: ["npx", "-y", "fs-mcp"] },
    })
    expect(rows).toEqual([
      { name: "docs", transport: "http", target: "https://example.com/mcp" },
      { name: "fs", transport: "stdio", target: "npx -y fs-mcp" },
    ])
  })

  it("returns [] for missing config", () => {
    expect(buildMcpRows(undefined)).toEqual([])
    expect(buildMcpRows({})).toEqual([])
  })
})

describe("formatTodoLine", () => {
  it("matches the /todo list markers and priority", () => {
    expect(formatTodoLine({ id: 1, content: "ship it", status: "pending", priority: "high" })).toBe(
      "[ ] #1 (high) ship it",
    )
    expect(formatTodoLine({ id: 2, content: "wip", status: "in_progress" })).toBe("[*] #2 wip")
    expect(formatTodoLine({ id: 3, content: "done", status: "completed" })).toBe("[x] #3 done")
  })
})

describe("hasOpenTodos", () => {
  it("hides the section for empty or fully-completed lists", () => {
    expect(hasOpenTodos([])).toBe(false)
    expect(hasOpenTodos([{ id: 1, content: "x", status: "completed" }])).toBe(false)
    expect(
      hasOpenTodos([
        { id: 1, content: "x", status: "completed" },
        { id: 2, content: "y", status: "pending" },
      ]),
    ).toBe(true)
  })
})
