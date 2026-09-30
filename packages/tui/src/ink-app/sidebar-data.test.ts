/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { buildMcpRows, capItems, contextUsage, formatTodoLine, hasOpenTodos } from "./sidebar-data.js"

describe("contextUsage", () => {
  it("computes the used percentage", () => {
    expect(contextUsage(32_000, 128_000)).toEqual({ tokens: 32_000, percent: 25 })
  })

  it("caps at 100% when tokens exceed the window", () => {
    expect(contextUsage(200_000, 128_000).percent).toBe(100)
  })

  it("returns null percent for an unknown window", () => {
    expect(contextUsage(1_000, undefined)).toEqual({ tokens: 1_000, percent: null })
    expect(contextUsage(1_000, 0).percent).toBeNull()
  })

  it("clamps negative / NaN input to zero tokens", () => {
    expect(contextUsage(-5).tokens).toBe(0)
    expect(contextUsage(Number.NaN).tokens).toBe(0)
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
