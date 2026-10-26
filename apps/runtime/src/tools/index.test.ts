/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import type { NemoConfig } from "../config.js"
import type { Tool } from "./types.js"
import { buildArsenalFromConfig, createDefaultTools, TOOLSET_DEFS } from "./index.js"

const namedTool = (name: string): Tool => ({
  definition: {
    timeoutMs: 30_000,
    name,
    description: "d",
    parameters: { type: "object", properties: {}, required: [] },
  },
  execute: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
})

describe("buildArsenalFromConfig — toolset resolution", () => {
  it("resolves tools belonging to the default toolsets", () => {
    const arsenal = buildArsenalFromConfig({} as NemoConfig)
    const tools = ["bash", "read_file", "not_a_registered_tool"].map(namedTool)
    expect(arsenal.resolveTools(tools).map((t) => t.definition.name).sort()).toEqual(["bash", "read_file"])
  })

  it("pins the defaults when config lists them", () => {
    const arsenal = buildArsenalFromConfig({ toolsets: { defaults: ["core"] } } as NemoConfig)
    const tools = ["bash", "nemo__Agent"].map(namedTool)
    expect(arsenal.resolveTools(tools).map((t) => t.definition.name)).toEqual(["bash"])
  })

  it("toolsets.disabled still wins — an explicit opt-out removes the toolset", () => {
    const arsenal = buildArsenalFromConfig({
      toolsets: { defaults: ["core"], disabled: ["core"] },
    } as NemoConfig)
    expect(arsenal.resolveTools(["bash"].map(namedTool))).toEqual([])
  })
})

describe("the pentest toolset is gone", () => {
  it("defines no pentest toolset", () => {
    expect(TOOLSET_DEFS.map((d) => d.name)).not.toContain("pentest")
  })

  it("never resolves a pentest tool", () => {
    const arsenal = buildArsenalFromConfig({} as NemoConfig)
    const pentestNames = [
      "nemo__PentestListTools",
      "nemo__PentestRunTool",
      "nemo__PentestStartEngagement",
      "nemo__PentestGetStatus",
      "nemo__PentestGetFindings",
    ]
    expect(arsenal.resolveTools(pentestNames.map(namedTool))).toEqual([])
  })
})

describe("createDefaultTools — model-facing set", () => {
  it("never exposes a pentest tool", () => {
    const { tools } = createDefaultTools(undefined, undefined, undefined, undefined, {} as NemoConfig)
    const names = new Set(tools.map((t) => t.definition.name))
    for (const name of names) {
      expect(name).not.toContain("Pentest")
    }
  })

  it("keeps the core tools model-facing with a config present", () => {
    const { tools } = createDefaultTools(undefined, undefined, undefined, undefined, {} as NemoConfig)
    const names = new Set(tools.map((t) => t.definition.name))
    expect(names.has("bash")).toBe(true)
    expect(names.has("read_file")).toBe(true)
  })
})
