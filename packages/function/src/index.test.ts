/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, it, expect } from "vitest"
import { FunctionRegistry, createFunctionRegistry } from "./index.js"
import type { Tool, ToolResult } from "../../../apps/runtime/src/index.js"

function makeTool(name: string): Tool {
  return {
    definition: {
      name,
      description: `tool ${name}`,
      parameters: { type: "object", properties: {}, required: [] },
      timeoutMs: 30_000,
    },
    async execute(_toolCallId, _args, _signal, _onUpdate, _context): Promise<ToolResult> {
      return { content: [{ type: "text", text: "ok" }], isError: false }
    },
  }
}

describe("FunctionRegistry", () => {
  it("registers and retrieves tools by name", () => {
    const registry = new FunctionRegistry()
    registry.register(makeTool("bash"))
    expect(registry.get("bash")?.definition.name).toBe("bash")
    expect(registry.get("missing")).toBeUndefined()
  })

  it("returns all definitions", () => {
    const registry = new FunctionRegistry()
    registry.register(makeTool("bash"))
    registry.register(makeTool("read"))
    expect(registry.definitions()).toHaveLength(2)
    expect(registry.names()).toContain("bash")
    expect(registry.names()).toContain("read")
  })

  it("createFunctionRegistry pre-populates from a tool list", () => {
    const tools = [makeTool("alpha"), makeTool("beta")]
    const r = createFunctionRegistry(tools)
    expect(r.names()).toHaveLength(2)
    expect(r.get("alpha")).toBeDefined()
  })

  it("overwrites on duplicate registration", () => {
    const registry = new FunctionRegistry()
    registry.register(makeTool("t"))
    const updated = { ...makeTool("t"), definition: { ...makeTool("t").definition, description: "new" } }
    registry.register(updated)
    expect(registry.definitions()).toHaveLength(1)
  })
})
