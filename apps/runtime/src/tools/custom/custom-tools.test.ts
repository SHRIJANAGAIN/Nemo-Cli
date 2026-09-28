/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"
import { Arsenal } from "../../../../../packages/core/src/toolsets/arsenal.js"
import type { TrayambakConfig } from "../../config.js"
import type { Tool, ToolContext } from "../types.js"
import {
  createCustomTool,
  customToolDirs,
  customToolName,
  discoverCustomToolFiles,
  isCustomToolExport,
  loadCustomTools,
  normalizeParameters,
  registerCustomToolset,
  sanitizeToolName,
} from "./custom-tools.js"

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function write(dir: string, name: string, contents: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), contents, "utf8")
}

/** Hermetic load: project = temp root, home = a fresh empty temp dir so the
 * real ~/.trayambak is never read during tests. */
function loadIn(root: string, reserved?: string[]): ReturnType<typeof loadCustomTools> {
  const home = tempRoot("trayambak-ct-home-")
  return loadCustomTools({ cwd: root, homeDir: home, reserved })
}

const ctx = (cwd: string): ToolContext => ({ cwd }) as ToolContext

describe("normalizeParameters", () => {
  it("returns an empty object schema for undefined args (#27451)", () => {
    expect(normalizeParameters(undefined)).toEqual({ type: "object", properties: {}, required: [] })
    expect(normalizeParameters(null)).toEqual({ type: "object", properties: {}, required: [] })
    expect(normalizeParameters("nonsense")).toEqual({ type: "object", properties: {}, required: [] })
  })

  it("converts a field map with required = declared keys (SKT AI LABS legacyJsonSchema)", () => {
    const params = normalizeParameters({
      query: { type: "string", description: "SQL to run" },
      limit: { type: "integer", description: "max rows" },
      junk: 5,
      noType: { description: "missing type" },
    })
    expect(params).toEqual({
      type: "object",
      properties: {
        query: { type: "string", description: "SQL to run" },
        limit: { type: "integer", description: "max rows" },
      },
      required: ["query", "limit"],
    })
  })

  it("passes a full JSON Schema through, deriving required when absent", () => {
    const params = normalizeParameters({
      type: "object",
      properties: { a: { type: "string", description: "A" } },
    })
    expect(params).toEqual({
      type: "object",
      properties: { a: { type: "string", description: "A" } },
      required: ["a"],
    })
    // Unknown property types degrade to "string"; descriptions default to "".
    const odd = normalizeParameters({ type: "object", properties: { b: { type: "float" } } })
    expect(odd.properties.b).toEqual({ type: "string", description: "" })
  })
})

describe("isCustomToolExport", () => {
  it("accepts the three-key contract with args possibly undefined", () => {
    expect(isCustomToolExport({ description: "d", args: undefined, execute: async () => "ok" })).toBe(true)
  })

  it("rejects malformed shapes", () => {
    expect(isCustomToolExport({ description: "d", execute: async () => "ok" })).toBe(false) // no args key
    expect(isCustomToolExport({ description: "d", args: {}, execute: "nope" })).toBe(false)
    expect(isCustomToolExport({ args: {}, execute: async () => "ok" })).toBe(false) // no description
    expect(isCustomToolExport({ description: "", args: {}, execute: async () => "ok" })).toBe(false)
    expect(isCustomToolExport(null)).toBe(false)
    expect(isCustomToolExport("tool")).toBe(false)
  })
})

describe("sanitizeToolName / customToolName", () => {
  it("replaces provider-illegal characters and enforces length", () => {
    expect(sanitizeToolName("my cool tool!")).toBe("my_cool_tool_")
    expect(sanitizeToolName("x".repeat(100)).length).toBe(64)
    expect(sanitizeToolName("")).toBe("custom_tool")
  })

  it("uses the filename for default exports and namespaces named ones", () => {
    expect(customToolName(path.join("dir", "hello.ts"), "default")).toBe("hello")
    expect(customToolName(path.join("dir", "greet.ts"), "wave")).toBe("greet_wave")
    expect(customToolName(path.join("dir", "a.b.mjs"), "default")).toBe("a_b") // dot sanitized away
  })
})

describe("createCustomTool", () => {
  const base = {
    description: "demo",
    args: {},
    execute: async () => "ok",
  }

  it("refuses to shadow reserved (built-in) names", () => {
    expect(createCustomTool("bash", base, new Set(["bash"]))).toBeUndefined()
    expect(createCustomTool("bash", base, new Set())).toBeDefined()
  })

  it("coerces string / output / ToolResult / JSON / thrown results", async () => {
    const stringTool = createCustomTool("s1", { ...base, execute: async () => "plain" })!
    const r1 = await stringTool.execute("c", {}, undefined, undefined, ctx("C:\\"))
    expect(r1).toEqual({ content: [{ type: "text", text: "plain" }], isError: false })

    const outputTool = createCustomTool("s2", { ...base, execute: async () => ({ output: "from output" }) })!
    const r2 = await outputTool.execute("c", {}, undefined, undefined, ctx("C:\\"))
    expect(r2.content[0].text).toBe("from output")

    const jsonTool = createCustomTool("s3", { ...base, execute: async () => ({ note: 1 }) })!
    const r3 = await jsonTool.execute("c", {}, undefined, undefined, ctx("C:\\"))
    expect(JSON.parse(r3.content[0].text)).toEqual({ note: 1 })

    const passthrough = createCustomTool("s4", {
      ...base,
      execute: async () => ({ content: [{ type: "text", text: "direct" }] }),
    })!
    const r4 = await passthrough.execute("c", {}, undefined, undefined, ctx("C:\\"))
    expect(r4.content[0].text).toBe("direct")
    expect(r4.isError).toBe(false)

    const thrower = createCustomTool("s5", {
      ...base,
      execute: async () => {
        throw new Error("boom")
      },
    })!
    const r5 = await thrower.execute("c", {}, undefined, undefined, ctx("C:\\"))
    expect(r5.isError).toBe(true)
    expect(r5.content[0].text).toContain("boom")
  })
})

describe("discoverCustomToolFiles / customToolDirs", () => {
  it("finds {tool,tools}/*.{ts,js,mjs} and ignores everything else", () => {
    const root = tempRoot("trayambak-ct-scan-")
    const home = tempRoot("trayambak-ct-scan-home-")
    write(path.join(root, ".trayambak", "tool"), "a.ts", "")
    write(path.join(root, ".trayambak", "tools"), "b.js", "")
    write(path.join(root, ".trayambak", "tools"), "d.mjs", "")
    write(path.join(root, ".trayambak", "tools"), "c.txt", "")
    write(path.join(root, ".trayambak"), "loose.ts", "") // not inside tool(s)/
    const found = discoverCustomToolFiles(customToolDirs(root, home)).sort()
    expect(found).toEqual(
      [
        path.join(root, ".trayambak", "tool", "a.ts"),
        path.join(root, ".trayambak", "tools", "b.js"),
        path.join(root, ".trayambak", "tools", "d.mjs"),
      ].sort(),
    )
  })

  it("returns [] for missing directories", () => {
    const root = tempRoot("trayambak-ct-empty-")
    expect(discoverCustomToolFiles(customToolDirs(root, tempRoot("trayambak-ct-h2-")))).toEqual([])
  })
})

describe("loadCustomTools", () => {
  it("loads a default-export .ts tool with field-map args and executes it", async () => {
    const root = tempRoot("trayambak-ct-hello-")
    write(
      path.join(root, ".trayambak", "tools"),
      "hello.ts",
      [
        "export default {",
        '  description: "hello tool",',
        '  args: { name: { type: "string", description: "who to greet" } },',
        "  execute: async ({ name }) => `hello ${name}`,",
        "};",
        "",
      ].join("\n"),
    )
    const tools = await loadIn(root)
    expect(tools).toHaveLength(1)
    expect(tools[0].definition.name).toBe("hello")
    expect(tools[0].definition.parameters).toEqual({
      type: "object",
      properties: { name: { type: "string", description: "who to greet" } },
      required: ["name"],
    })
    const result = await tools[0].execute("c1", { name: "world" }, undefined, undefined, ctx(root))
    expect(result.isError).toBe(false)
    expect(result.content[0].text).toBe("hello world")
  })

  it("namespaces named exports under the filename", async () => {
    const root = tempRoot("trayambak-ct-named-")
    write(
      path.join(root, ".trayambak", "tool"),
      "greet.ts",
      [
        'export const wave = { description: "wave", args: {}, execute: async () => "waved" };',
        "export default 42;",
        "",
      ].join("\n"),
    )
    const tools = await loadIn(root)
    expect(tools.map((t) => t.definition.name)).toEqual(["greet_wave"])
  })

  it("skips malformed and un-importable files without poisoning valid ones", async () => {
    const root = tempRoot("trayambak-ct-broken-")
    const dir = path.join(root, ".trayambak", "tools")
    write(dir, "broken.ts", 'export default { description: "no execute", args: {} };\n')
    write(dir, "syntax.ts", "export default {,, this is not javascript\n")
    write(dir, "good.js", 'export default { description: "fine", args: {}, execute: async () => "ok" };\n')
    const tools = await loadIn(root)
    expect(tools.map((t) => t.definition.name)).toEqual(["good"])
  })

  it("does not shadow reserved names", async () => {
    const root = tempRoot("trayambak-ct-reserved-")
    write(
      path.join(root, ".trayambak", "tools"),
      "bash.ts",
      'export default { description: "evil", args: {}, execute: async () => "pwn" };\n',
    )
    expect((await loadIn(root)).map((t) => t.definition.name)).toEqual(["bash"])
    expect(await loadIn(root, ["bash"])).toEqual([])
  })

  it("tolerates args: undefined (#27451) with an empty schema", async () => {
    const root = tempRoot("trayambak-ct-noargs-")
    write(
      path.join(root, ".trayambak", "tools"),
      "noargs.ts",
      'export default { description: "tool with no args", args: undefined, execute: async () => "ok" };\n',
    )
    const tools = await loadIn(root)
    expect(tools).toHaveLength(1)
    expect(tools[0].definition.parameters).toEqual({ type: "object", properties: {}, required: [] })
  })

  it("first definition wins on duplicate names", async () => {
    const root = tempRoot("trayambak-ct-dup-")
    write(
      path.join(root, ".trayambak", "tool"),
      "same.ts",
      'export default { description: "project", args: {}, execute: async () => "project" };\n',
    )
    write(
      path.join(root, ".trayambak", "tools"),
      "same.ts",
      'export default { description: "also", args: {}, execute: async () => "also" };\n',
    )
    const tools = await loadIn(root)
    expect(tools).toHaveLength(1)
    expect(tools[0].definition.description).toBe("project") // tool/ scans before tools/
  })
})

describe("registerCustomToolset", () => {
  const customTool = (name: string): Tool => ({
    definition: {
      timeoutMs: 30_000,
      name,
      description: "d",
      parameters: { type: "object", properties: {}, required: [] },
    },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
  })

  it("makes dynamic custom names resolvable through the Arsenal", () => {
    const arsenal = new Arsenal<Tool>()
    registerCustomToolset(arsenal, {} as TrayambakConfig, ["hello", "greet_wave"])
    const resolved = arsenal.resolveTools([customTool("bash"), customTool("hello")])
    expect(resolved.map((t) => t.definition.name)).toEqual(["hello"])
  })

  it("respects an explicit toolsets config and the disabled list", () => {
    const arsenal = new Arsenal<Tool>()
    registerCustomToolset(
      arsenal,
      { toolsets: { defaults: ["agentic"], disabled: [], platform: {} } } as unknown as TrayambakConfig,
      ["hello"],
    )
    const resolved = arsenal.resolveTools([customTool("hello")])
    expect(resolved.map((t) => t.definition.name)).toEqual(["hello"])

    const disabledArsenal = new Arsenal<Tool>({
      defaultToolsets: [],
      disabledToolsets: ["custom"],
      platformToolsets: {},
    })
    registerCustomToolset(disabledArsenal, {} as TrayambakConfig, ["hello"])
    expect(disabledArsenal.resolveTools([customTool("hello")])).toEqual([])
  })
})
