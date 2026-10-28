/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, vi } from "vitest"
import type { Provider } from "../../../../../packages/provider/src/index.js"
import { createFimTool } from "./fim.js"

function assistantText(text: string): {
  role: "assistant"
  content: Array<{ type: "text"; text: string }>
  stopReason: "end_turn"
} {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn" }
}

describe("createFimTool", () => {
  it("exposes the fim identity", () => {
    expect(createFimTool().definition.name).toBe("fim")
    expect(createFimTool().definition.timeoutMs).toBe(30_000)
  })

  it("rejects a missing prefix without touching the provider", async () => {
    const getProvider = vi.fn()
    const tool = createFimTool(getProvider)
    const result = await tool.execute("t1", {}, undefined, undefined, undefined as never)

    expect(result.isError).toBe(true)
    expect(getProvider).not.toHaveBeenCalled()
  })

  it("says honestly when no provider or no FIM endpoint exists", async () => {
    const noProvider = createFimTool(undefined)
    const r1 = await noProvider.execute("t1", { prefix: "x" }, undefined, undefined, undefined as never)
    expect(r1.isError).toBe(true)

    const chatOnly: Provider = { id: "legacy", chat: async () => assistantText("hi") }
    const noFim = createFimTool(() => chatOnly)
    const r2 = await noFim.execute("t1", { prefix: "x" }, undefined, undefined, undefined as never)
    expect(r2.isError).toBe(true)
    expect(r2.content.map((c) => c.text).join()).toContain("legacy")
  })

  it("forwards prefix/suffix/budgets and returns the middle", async () => {
    const seen: Array<Record<string, unknown>> = []
    const provider: Provider = {
      id: "test",
      chat: async () => assistantText("hi"),
      fim: async (input) => {
        seen.push({ ...input })
        return { text: "middle();" }
      },
    }
    const tool = createFimTool(() => provider)
    const result = await tool.execute(
      "t1",
      { prefix: "function f() {", suffix: "}", max_tokens: 64, temperature: 0 },
      undefined,
      undefined,
      undefined as never,
    )

    expect(result.isError).toBe(false)
    expect(result.content.map((c) => c.text).join()).toBe("middle();")
    expect(seen).toHaveLength(1)
    expect(seen[0]?.prompt).toBe("function f() {")
    expect(seen[0]?.suffix).toBe("}")
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
    const tool = createFimTool(() => provider)
    const result = await tool.execute(
      "t1",
      { prefix: "x", max_tokens: 99999, temperature: -5 },
      undefined,
      undefined,
      undefined as never,
    )

    expect(result.isError).toBe(true)
    expect(result.content.map((c) => c.text).join()).toContain("endpoint down")
    expect(seen[0]).toEqual({ maxTokens: 4096, temperature: 0 })
  })
})
