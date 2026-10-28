/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Every real tool's schema must be self-consistent.
 *
 * This is a repo-wide invariant test rather than a unit test of the validator.
 * A schema that says `required: ["path"]` while declaring no `path` property
 * tells the model to send a field it has no type or description for — the tool
 * is then harder to call correctly because of its own declaration, and nothing
 * in the runtime reports it. An array property with no `items` says nothing about
 * what the array holds.
 *
 * Both mistakes pass runtime validation forever while quietly degrading every
 * call, which is exactly the class of defect a test should pin.
 */

import { describe, expect, it } from "vitest"
import { createDefaultTools } from "./index.js"
import { auditToolSchemas } from "./validate-args.js"
import type { Tool } from "./types.js"

/**
 * Built once: constructing the full catalogue is not free and nothing here
 * mutates it. `createDefaultTools` returns a `{ tools, arsenal }` bundle, not a
 * bare array.
 */
const { tools } = createDefaultTools()

describe("tool schema invariants across the whole catalogue", () => {
  it("the catalogue is not empty — a vacuous pass here would be meaningless", () => {
    // Without this, a refactor that broke `createDefaultTools` would make every
    // assertion below pass for the wrong reason.
    expect(tools.length).toBeGreaterThan(50)
  })

  it("no tool declares a required argument it never defines", () => {
    const problems = auditToolSchemas(tools)
    expect(problems.filter((p) => p.problem.includes("required"))).toEqual([])
  })

  it("no tool declares an array without saying what it holds", () => {
    const problems = auditToolSchemas(tools)
    expect(problems.filter((p) => p.problem.includes("no items schema"))).toEqual([])
  })

  it("no tool declares an empty enum", () => {
    const problems = auditToolSchemas(tools)
    expect(problems.filter((p) => p.problem.includes("enum"))).toEqual([])
  })

  it("every tool has a name and a description", () => {
    // Both go to the model. An empty description means the model is calling a
    // tool whose purpose it was never told.
    for (const tool of tools) {
      expect(tool.definition.name, "tool name").not.toBe("")
      expect(tool.definition.description.trim(), `${tool.definition.name} description`).not.toBe("")
    }
  })

  it("tool names are unique", () => {
    // A duplicate name means the registry holds two tools the model cannot
    // distinguish, and the second silently shadows the first at call time.
    const names = tools.map((t) => t.definition.name)
    const duplicates = names.filter((name, i) => names.indexOf(name) !== i)
    expect(duplicates).toEqual([])
  })

  it("every declared required property has a description", () => {
    // Required-without-description is the milder version of the same defect: the
    // model knows the field is mandatory but not what to put in it.
    const missing: string[] = []
    for (const tool of tools) {
      for (const key of tool.definition.parameters.required) {
        const property = tool.definition.parameters.properties[key]
        if (property !== undefined && (property.description ?? "").trim() === "") {
          missing.push(`${tool.definition.name}.${key}`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})