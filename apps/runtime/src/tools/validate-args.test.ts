/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Argument validation at the tool boundary.
 *
 * The behaviour that must not regress:
 *
 *  - **A rejected call never reaches the tool body.** The body is what produces
 *    the misleading deep error ("no such file") that costs the model a turn.
 *  - **Rejection is an `isError` result, not a throw.** Tools report problems in
 *    their result content and the loop renders those as a transcript row the
 *    model reads next turn. Throwing ends the turn before the model ever sees
 *    the complaint, which is the opposite of what self-correction needs.
 *  - **The tool name is in the message.** Several tools run in one parallel
 *    batch, so identical complaint text would be ambiguous.
 *  - **A tool with no declared parameters still runs.** An empty schema must not
 *    become a blanket rejection — that would break every argument-taking tool
 *    whose schema a provider mangled.
 */

import { describe, expect, it, vi } from "vitest"
import { auditToolSchemas, validateArguments } from "./validate-args.js"
import type { Tool } from "./types.js"
import type { ToolDefinition, ToolParameters, ToolResult } from "../../../../packages/protocol/src/index.js"

/**
 * `timeoutMs` is present because `require-tool-timeout` applies to every tool
 * definition including test fixtures: a definition without it is exactly the
 * shape that lets a tool wedge a turn in production.
 */
const definition = (parameters: ToolParameters, name = "demo"): ToolDefinition => ({
  name,
  description: "demo tool",
  parameters,
  timeoutMs: 30_000,
})

const toolWith = (parameters: ToolParameters, body: () => Promise<ToolResult>, name = "demo"): Tool => ({
  definition: definition(parameters, name),
  execute: body,
})

const text = (result: ToolResult): string =>
  result.content.map((c) => (c.type === "text" ? c.text : "")).join("")

/**
 * A successful tool result. `isError` is REQUIRED on `ToolResult` rather than
 * optional, which is deliberate: a tool that forgets it would otherwise render
 * as a silent success.
 */
const ok = (t = "ran"): ToolResult => ({ content: [{ type: "text", text: t }], isError: false })

const emptyParams: ToolParameters = { type: "object", properties: {}, required: [] }

describe("validateArguments — passing calls", () => {
  it("delegates to the body when the arguments satisfy the schema", async () => {
    const execute = vi.fn(async (): Promise<ToolResult> => ok())
    const wrapped = validateArguments(
      toolWith({ type: "object", properties: { path: { type: "string", description: "p" } }, required: ["path"] }, execute),
    )
    const result = await wrapped.execute("1", { path: "a.ts" }, undefined, undefined, undefined)
    expect(execute).toHaveBeenCalledOnce()
    expect(text(result)).toBe("ran")
  })

  it("forwards the ORIGINAL arguments untouched", async () => {
    // Coercion here would be a lie: the tool body has its own contract, and the
    // wrapper's job is to reject, not to rewrite.
    const execute = vi.fn(async (): Promise<ToolResult> => ok())
    const wrapped = validateArguments(toolWith(emptyParams, execute))
    const args = { extra: 1 }
    await wrapped.execute("1", args, undefined, undefined, undefined)
    expect(execute).toHaveBeenCalledWith("1", args, undefined, undefined, undefined)
  })
})

describe("validateArguments — rejecting calls", () => {
  it("does NOT run the body when a required argument is missing", async () => {
    const execute = vi.fn(async (): Promise<ToolResult> => ok())
    const wrapped = validateArguments(
      toolWith({ type: "object", properties: { path: { type: "string", description: "p" } }, required: ["path"] }, execute),
    )
    const result = await wrapped.execute("1", {}, undefined, undefined, undefined)
    expect(execute).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(text(result)).toContain("missing required argument")
  })

  it("names the tool so the complaint is unambiguous in a parallel batch", async () => {
    const wrapped = validateArguments(
      toolWith({ type: "object", properties: { path: { type: "string", description: "p" } }, required: ["path"] }, async () => ok(), "nemo__ReadFile"),
    )
    const result = await wrapped.execute("1", {}, undefined, undefined, undefined)
    expect(text(result)).toContain("nemo__ReadFile rejected the call")
  })

  it("reports the expected and received types", async () => {
    const wrapped = validateArguments(
      toolWith({ type: "object", properties: { path: { type: "string", description: "p" } }, required: ["path"] }, async () => ok()),
    )
    const result = await wrapped.execute("1", { path: 42 }, undefined, undefined, undefined)
    expect(text(result)).toContain("must be a string")
    expect(text(result)).toContain("received number")
  })

  it("returns a result rather than throwing", async () => {
    // A throw here would end the turn before the model could read the complaint.
    const wrapped = validateArguments(
      toolWith({ type: "object", properties: { path: { type: "string", description: "p" } }, required: ["path"] }, async () => ok()),
    )
    await expect(wrapped.execute("1", {}, undefined, undefined, undefined)).resolves.toBeDefined()
  })

  it("enforces an enum", async () => {
    const wrapped = validateArguments(
      toolWith(
        { type: "object", properties: { mode: { type: "string", description: "m", enum: ["text", "image"] } }, required: ["mode"] },
        async () => ok(),
      ),
    )
    const result = await wrapped.execute("1", { mode: "binary" }, undefined, undefined, undefined)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('"text"')
  })
})

describe("validateArguments — degraded schemas", () => {
  it("a tool with NO parameters still runs with any arguments", async () => {
    // An empty schema must not become a blanket rejection.
    const execute = vi.fn(async (): Promise<ToolResult> => ok())
    const wrapped = validateArguments(toolWith(emptyParams, execute))
    const result = await wrapped.execute("1", { anything: true }, undefined, undefined, undefined)
    expect(execute).toHaveBeenCalledOnce()
    expect(result.isError).not.toBe(true)
  })

  it("an undefined argument object is fine when nothing is required", async () => {
    const wrapped = validateArguments(toolWith(emptyParams, async () => ok()))
    const result = await wrapped.execute("1", undefined as unknown as Record<string, unknown>, undefined, undefined, undefined)
    expect(result.isError).not.toBe(true)
  })

  it("a required key with no property definition does not reject forever", async () => {
    // The schema lies about itself here; the audit reports it, but the wrapper
    // must not make the tool permanently unusable because of it.
    const schema = {
      type: "object" as const,
      properties: {},
      required: ["ghost"],
    }
    const wrapped = validateArguments(toolWith(schema, async () => ok()))
    const result = await wrapped.execute("1", {}, undefined, undefined, undefined)
    expect(result.isError).not.toBe(true)
  })

  it("preserves the tool's identity, not a wrapper's", async () => {
    // Other code reads `definition.name`, `definition.timeoutMs`, and
    // `executionMode` off the object it receives; a wrapper that dropped them
    // would break the timeout gate and the parallel-batching decision.
    const base: Tool = {
      definition: { ...definition(emptyParams, "x"), executionMode: "sequential", timeoutMs: 1234 },
      execute: async () => ok(),
    }
    const wrapped = validateArguments(base)
    expect(wrapped.definition.name).toBe("x")
    expect(wrapped.definition.timeoutMs).toBe(1234)
    expect(wrapped.definition.executionMode).toBe("sequential")
  })
})

describe("auditToolSchemas", () => {
  const mk = (parameters: ToolParameters, name = "t"): Tool => ({
    definition: definition(parameters, name),
    execute: async () => ok(""),
  })

  it("is clean for a well-formed schema", () => {
    const problems = auditToolSchemas([
      mk({ type: "object", properties: { path: { type: "string", description: "p" } }, required: ["path"] }),
    ])
    expect(problems).toEqual([])
  })

  it("flags a required key with no property definition", () => {
    // The model is told to send a field it was never given a type or
    // description for, so it can only guess.
    const problems = auditToolSchemas([mk({ type: "object", properties: {}, required: ["path"] })])
    expect(problems).toHaveLength(1)
    expect(problems[0]!.problem).toContain('required "path"')
  })

  it("flags an array property with no items schema", () => {
    const problems = auditToolSchemas([
      mk({ type: "object", properties: { files: { type: "array", description: "f" } }, required: [] }),
    ])
    expect(problems[0]!.problem).toContain("no items schema")
  })

  it("flags an empty enum", () => {
    const problems = auditToolSchemas([
      mk({ type: "object", properties: { m: { type: "string", description: "m", enum: [] } }, required: [] }),
    ])
    expect(problems[0]!.problem).toContain("enum")
  })

  it("reports every problem, not just the first", () => {
    const problems = auditToolSchemas([
      mk(
        {
          type: "object",
          properties: { files: { type: "array", description: "f" }, m: { type: "string", description: "m", enum: [] } },
          required: ["ghost"],
        },
        "multi",
      ),
    ])
    expect(problems.length).toBeGreaterThanOrEqual(3)
    expect(problems.every((p) => p.tool === "multi")).toBe(true)
  })

  it("reports a malformed parameters block rather than throwing", () => {
    const bad = {
      definition: { name: "bad", description: "", parameters: null, timeoutMs: 30_000 },
      execute: async () => ({ content: [] }),
    } as unknown as Tool
    expect(auditToolSchemas([bad])).toHaveLength(1)
  })
})