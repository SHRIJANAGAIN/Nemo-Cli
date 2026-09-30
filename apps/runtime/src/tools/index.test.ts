/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import type { TrayambakConfig } from "../config.js"
import type { Tool } from "./types.js"
import { buildArsenalFromConfig, createDefaultTools } from "./index.js"

/** The 5 model-facing pentest meta-tools (toolsets.pentest). */
const PENTEST_TOOLS = [
  "trayambak__PentestListTools",
  "trayambak__PentestRunTool",
  "trayambak__PentestStartEngagement",
  "trayambak__PentestGetStatus",
  "trayambak__PentestGetFindings",
]

const namedTool = (name: string): Tool => ({
  definition: {
    timeoutMs: 30_000,
    name,
    description: "d",
    parameters: { type: "object", properties: {}, required: [] },
  },
  execute: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
})

describe("buildArsenalFromConfig — pentest default", () => {
  it("keeps the pentest toolset in the defaults even when config omits it", () => {
    const arsenal = buildArsenalFromConfig({} as TrayambakConfig)
    const resolved = arsenal.resolveTools(PENTEST_TOOLS.map(namedTool))
    expect(resolved.map((t) => t.definition.name).sort()).toEqual([...PENTEST_TOOLS].sort())
  })

  it("keeps pentest when config pins defaults to a list without it", () => {
    const arsenal = buildArsenalFromConfig({ toolsets: { defaults: ["core"] } } as TrayambakConfig)
    const resolved = arsenal.resolveTools(PENTEST_TOOLS.map(namedTool))
    expect(resolved).toHaveLength(PENTEST_TOOLS.length)
  })

  it("toolsets.disabled still wins — an explicit opt-out removes pentest", () => {
    const arsenal = buildArsenalFromConfig({
      toolsets: { defaults: ["core"], disabled: ["pentest"] },
    } as TrayambakConfig)
    expect(arsenal.resolveTools(PENTEST_TOOLS.map(namedTool))).toEqual([])
  })
})

describe("createDefaultTools — pentest reaches the model-facing set", () => {
  it("returns all 5 Pentest* tools with a config present", () => {
    const { tools } = createDefaultTools(undefined, undefined, undefined, undefined, {} as TrayambakConfig)
    const names = new Set(tools.map((t) => t.definition.name))
    for (const pentestTool of PENTEST_TOOLS) {
      expect(names.has(pentestTool)).toBe(true)
    }
  })

  it("drops the Pentest* tools when pentest is disabled", () => {
    const { tools } = createDefaultTools(undefined, undefined, undefined, undefined, {
      toolsets: { defaults: ["core", "agentic", "ops", "tasks", "mcp", "skills"], disabled: ["pentest"] },
    } as TrayambakConfig)
    const names = new Set(tools.map((t) => t.definition.name))
    for (const pentestTool of PENTEST_TOOLS) {
      expect(names.has(pentestTool)).toBe(false)
    }
  })
})
