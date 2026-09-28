/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { createYamlTool, parseYamlComment } from "./yaml.js"
import type { ToolResult } from "../../../../../packages/protocol/src/index.js"

const scalar = (node: unknown): string | undefined => (node as { scalar?: string }).scalar

describe("parseYamlComment", () => {
  it("parses unquoted, quoted, null, and tilde scalars", () => {
    const doc = parseYamlComment(
      ["name: trayambak", 'version: "2.0"', "author: 'SKT AI LABS'", "empty: null", "tilde: ~", "nothing:"].join("\n"),
    )
    expect(doc.kind).toBe("map")
    const entries: Record<string, string | undefined> = {}
    for (const e of doc.mapEntries ?? []) entries[e.key] = scalar(e.value)
    expect(entries["name"]).toBe("trayambak")
    expect(entries["version"]).toBe("2.0")
    expect(entries["author"]).toBe("SKT AI LABS")
    expect(entries["empty"]).toBe("")
    expect(entries["tilde"]).toBe("")
    // A key with no inline value resolves to an (empty) sub-block map.
    expect(entries["nothing"]).toBeUndefined()
    const nothing = doc.mapEntries?.find((e) => e.key === "nothing")?.value
    expect(nothing?.kind).toBe("map")
    expect(nothing?.mapEntries).toEqual([])
  })

  it("strips trailing comments from unquoted scalars and whole-line comments", () => {
    const doc = parseYamlComment(["# a header", "port: 8080 # http", "only: # nothing here"].join("\n"))
    const entries: Record<string, string | undefined> = {}
    for (const e of doc.mapEntries ?? []) entries[e.key] = scalar(e.value)
    expect(entries["port"]).toBe("8080")
    expect(entries["only"]).toBe("")
    expect(doc.mapEntries?.length).toBe(2)
  })

  it("keeps the quoted form when a comment follows a quoted value", () => {
    const doc = parseYamlComment('k: "val" # note')
    expect(scalar(doc.mapEntries?.[0]?.value)).toBe('"val"')
  })

  it("unescapes \\n inside double-quoted scalars", () => {
    const doc = parseYamlComment('path: "line1\\nline2"')
    expect(scalar(doc.mapEntries?.[0]?.value)).toBe("line1\nline2")
  })

  it("parses nested maps and scalar lists", () => {
    const doc = parseYamlComment(
      ["build:", "  steps:", "    - npm test", "    - npm run lint", "  cache: true"].join("\n"),
    )
    const build = doc.mapEntries?.find((e) => e.key === "build")?.value
    expect(build?.kind).toBe("map")
    const steps = build?.mapEntries?.find((e) => e.key === "steps")?.value
    expect(steps?.kind).toBe("list")
    expect(steps?.listItems?.map((i) => scalar(i))).toEqual(["npm test", "npm run lint"])
    expect(scalar(build?.mapEntries?.find((e) => e.key === "cache")?.value)).toBe("true")
  })

  it("parses list entries that are single-key maps", () => {
    const doc = parseYamlComment(["jobs:", "  - name: build", "  - name: deploy"].join("\n"))
    const jobs = doc.mapEntries?.find((e) => e.key === "jobs")?.value
    expect(jobs?.kind).toBe("list")
    expect(jobs?.listItems?.length).toBe(2)
    expect(scalar(jobs?.listItems?.[0]?.mapEntries?.[0]?.value)).toBe("build")
    expect(jobs?.listItems?.[0]?.mapEntries?.[0]?.key).toBe("name")
  })

  it("skips blank lines while parsing", () => {
    const doc = parseYamlComment(["", "a: 1", "", "b: 2", ""].join("\n"))
    expect(doc.mapEntries?.length).toBe(2)
  })

  it("accepts a top-level list", () => {
    const doc = parseYamlComment(["- one", "- two"].join("\n"))
    expect(doc.kind).toBe("list")
    expect(doc.listItems?.map((i) => scalar(i))).toEqual(["one", "two"])
  })

  it("falls back to bare markers as map entries when the root has no keys", () => {
    const doc = parseYamlComment("---")
    expect(doc.kind).toBe("map")
    expect(doc.mapEntries?.length).toBe(1)
    expect(doc.mapEntries?.[0]?.key).toBe("---")
    expect(scalar(doc.mapEntries?.[0]?.value)).toBe("<value>")
  })

  it("ignores bare markers once real keys exist", () => {
    const doc = parseYamlComment(["key: v", "---"].join("\n"))
    expect(doc.mapEntries?.length).toBe(1)
    expect(doc.mapEntries?.[0]?.key).toBe("key")
  })

  it("ends a nested block when indentation drops back down", () => {
    const doc = parseYamlComment(["outer:", "  inner: deep", "next: 1"].join("\n"))
    expect(doc.mapEntries?.map((e) => e.key)).toEqual(["outer", "next"])
    expect(doc.mapEntries?.[1]?.value.kind).toBe("scalar")
  })

  it("treats the maxDepth argument as reserved (no effect on output)", () => {
    const text = "a: 1"
    expect(parseYamlComment(text, 1)).toEqual(parseYamlComment(text))
  })
})

describe("yaml tool", () => {
  let tmp = ""
  let originalCwd = ""

  beforeEach(() => {
    originalCwd = process.cwd()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-yaml-"))
    process.chdir(tmp)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const run = async (args: Record<string, unknown>): Promise<ToolResult> =>
    createYamlTool().execute("call-1", args, undefined)

  const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text

  it("renders a whole document as an indented structure", async () => {
    fs.writeFileSync(path.join(tmp, "app.yaml"), "a: 1\nb:\n  c: two\n", "utf8")
    const res = await run({ file: "app.yaml" })
    expect(res.isError).toBe(false)
    expect(textOf(res)).toBe("a: 1\nb:\n  c: two")
  })

  it("extracts a dotted key path with a header comment", async () => {
    fs.writeFileSync(path.join(tmp, "app.yaml"), "a: 1\nb:\n  c: two\n", "utf8")
    const res = await run({ file: "app.yaml", key: "b.c" })
    expect(textOf(res)).toBe("# b.c\ntwo")
  })

  it("extracts a nested map subtree", async () => {
    fs.writeFileSync(path.join(tmp, "app.yaml"), "a: 1\nb:\n  c: two\n", "utf8")
    const res = await run({ file: "app.yaml", key: "b" })
    expect(textOf(res)).toBe("# b\nc: two")
  })

  it("reports a missing key path instead of throwing", async () => {
    fs.writeFileSync(path.join(tmp, "app.yaml"), "a: 1\n", "utf8")
    const res = await run({ file: "app.yaml", key: "missing.path" })
    expect(res.isError).toBe(false)
    expect(textOf(res)).toBe("# missing.path\n(not found)")
  })

  it("renders lists with dash prefixes", async () => {
    fs.writeFileSync(path.join(tmp, "app.yaml"), "items:\n  - a\n  - b\n", "utf8")
    const res = await run({ file: "app.yaml" })
    expect(textOf(res)).toBe("items:\n  - a\n  - b")
  })

  it("says (empty) for a blank file", async () => {
    fs.writeFileSync(path.join(tmp, "blank.yaml"), "", "utf8")
    const res = await run({ file: "blank.yaml" })
    expect(textOf(res)).toBe("(empty)")
  })

  it("fails with a clear error for a missing file", async () => {
    const res = await run({ file: "absent.yaml" })
    expect(res.isError).toBe(true)
    expect(textOf(res).startsWith("yaml failed:")).toBe(true)
  })
})
