/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, vi } from "vitest"
import type { Provider } from "../../../../../packages/provider/src/index.js"
import { buildNextEditPrompt, createNextEditTool } from "./next-edit.js"

function assistantText(text: string): {
  role: "assistant"
  content: Array<{ type: "text"; text: string }>
  stopReason: "end_turn"
} {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn" }
}

describe("buildNextEditPrompt", () => {
  it("passes short context through with a hint comment", () => {
    const built = buildNextEditPrompt("const x =", ";\n", "close the statement")
    expect(built.prompt).toContain("const x =")
    expect(built.prompt).toContain("next edit: close the statement")
    expect(built.suffix).toBe(";\n")
  })

  it("bounds long contexts", () => {
    const built = buildNextEditPrompt("a".repeat(9000), "b".repeat(5000))
    expect(built.prompt.length).toBeLessThanOrEqual(4300)
    expect(built.suffix.length).toBeLessThanOrEqual(2000)
  })
})

describe("createNextEditTool", () => {
  it("exposes the next_edit identity", () => {
    expect(createNextEditTool().definition.name).toBe("next_edit")
    expect(createNextEditTool().definition.timeoutMs).toBe(30_000)
  })

  it("rejects a missing prefix without touching the provider", async () => {
    const getProvider = vi.fn()
    const tool = createNextEditTool(getProvider)
    const result = await tool.execute("t1", {}, undefined, undefined, undefined as never)

    expect(result.isError).toBe(true)
    expect(getProvider).not.toHaveBeenCalled()
  })

  it("says honestly when no provider or no FIM endpoint exists", async () => {
    const noProvider = createNextEditTool(undefined)
    const r1 = await noProvider.execute("t1", { prefix: "x" }, undefined, undefined, undefined as never)
    expect(r1.isError).toBe(true)

    const chatOnly: Provider = { id: "legacy", chat: async () => assistantText("hi") }
    const noFim = createNextEditTool(() => chatOnly)
    const r2 = await noFim.execute("t1", { prefix: "x" }, undefined, undefined, undefined as never)
    expect(r2.isError).toBe(true)
    expect(r2.content.map((c) => c.text).join()).toContain("legacy")
  })

  it("forwards bounded prompts and returns the trimmed suggestion", async () => {
    const seen: Array<Record<string, unknown>> = []
    const provider: Provider = {
      id: "test",
      chat: async () => assistantText("hi"),
      fim: async (input) => {
        seen.push({ ...input })
        return { text: "  middle();\n" }
      },
    }
    const tool = createNextEditTool(() => provider)
    const result = await tool.execute(
      "t1",
      { prefix: "function f() {", suffix: "}", hint: "close it", max_tokens: 64, temperature: 0 },
      undefined,
      undefined,
      undefined as never,
    )

    expect(result.isError).toBe(false)
    expect(result.content.map((c) => c.text).join()).toBe("middle();")
    expect(seen).toHaveLength(1)
    expect(String(seen[0]?.prompt)).toContain("function f() {")
    expect(seen[0]?.maxTokens).toBe(64)
  })

  it("clamps budgets and reports provider failures", async () => {
    const seen: Array<Record<string, unknown>> = []
    const provider: Provider = {
      id: "test",
      chat: async () => assistantText("hi"),
      fim: async (input) => {
        seen.push({ maxTokens: input.maxTokens, temperature: input.temperature })
        throw new Error("endpoint down")
      },
    }
    const tool = createNextEditTool(() => provider)
    const result = await tool.execute(
      "t1",
      { prefix: "x", max_tokens: 99999, temperature: -5 },
      undefined,
      undefined,
      undefined as never,
    )

    expect(result.isError).toBe(true)
    expect(result.content.map((c) => c.text).join()).toContain("endpoint down")
    expect(seen[0]).toEqual({ maxTokens: 1024, temperature: 0 })
  })
})
