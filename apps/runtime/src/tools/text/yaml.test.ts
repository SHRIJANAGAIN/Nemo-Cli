/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { createYamlTool, parseYamlComment } from "./yaml.js"
import type { ToolResult } from "../../../../../packages/protocol/src/index.js"
import type { ToolContext } from "../types.js"

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

  it("keeps backslash sequences literal inside single-quoted scalars", () => {
    // YAML single quotes do NOT process escapes: 'a\nb' is the 4-char text.
    const doc = parseYamlComment("msg: 'no\\nbreak'")
    expect(scalar(doc.mapEntries?.[0]?.value)).toBe("no\\nbreak")
  })

  it("keeps a # that is part of the value (URL fragments) instead of stripping it", () => {
    const doc = parseYamlComment("url: https://example.com/x#frag")
    expect(scalar(doc.mapEntries?.[0]?.value)).toBe("https://example.com/x#frag")
  })

  it("keeps every field of a multi-key list item (CI step shape)", () => {
    const doc = parseYamlComment(["jobs:", "  - name: build", "    command: go build", "    env: prod"].join("\n"))
    const jobs = doc.mapEntries?.find((e) => e.key === "jobs")?.value
    expect(jobs?.kind).toBe("list")
    const item = jobs?.listItems?.[0]
    expect(item?.mapEntries?.map((e) => e.key)).toEqual(["name", "command", "env"])
    expect(scalar(item?.mapEntries?.[1]?.value)).toBe("go build")
    expect(scalar(item?.mapEntries?.[2]?.value)).toBe("prod")
  })

  it("attaches nested sub-maps inside a list item", () => {
    const doc = parseYamlComment(["steps:", "  - name: build", "    with:", '      go: "1.21"'].join("\n"))
    const steps = doc.mapEntries?.find((e) => e.key === "steps")?.value
    const item = steps?.listItems?.[0]
    expect(item?.mapEntries?.map((e) => e.key)).toEqual(["name", "with"])
    const withMap = item?.mapEntries?.find((e) => e.key === "with")?.value
    expect(withMap?.kind).toBe("map")
    expect(scalar(withMap?.mapEntries?.[0]?.value)).toBe("1.21")
  })

  it("parses nested blocks indented with more than two spaces", () => {
    const doc = parseYamlComment(["root:", "    child:", "        value: 42"].join("\n"))
    const root = doc.mapEntries?.find((e) => e.key === "root")?.value
    const child = root?.mapEntries?.find((e) => e.key === "child")
    expect(child?.key).toBe("child")
    expect(scalar(child?.value.mapEntries?.[0]?.value)).toBe("42")
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

  it("renders a multi-key list item with its fields inline", async () => {
    fs.writeFileSync(path.join(tmp, "ci.yaml"), "steps:\n  - name: build\n    command: go build\n", "utf8")
    const res = await run({ file: "ci.yaml" })
    expect(res.isError).toBe(false)
    expect(textOf(res)).toBe("steps:\n  - name: build\n    command: go build")
  })

  it("resolves relative file paths against the tool context cwd", async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-yaml-cwd-"))
    try {
      fs.writeFileSync(path.join(other, "c.yaml"), "name: ok\n", "utf8")
      const res = await createYamlTool().execute("call-1", { file: "c.yaml" }, undefined, undefined, {
        cwd: other,
      } as ToolContext)
      expect(res.isError).toBe(false)
      expect(textOf(res)).toBe("name: ok")
      // The process working directory must not be consulted for the file.
      expect(fs.existsSync(path.join(process.cwd(), "c.yaml"))).toBe(false)
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  it("fails with a clear error for a missing file", async () => {
    const res = await run({ file: "absent.yaml" })
    expect(res.isError).toBe(true)
    expect(textOf(res).startsWith("yaml failed:")).toBe(true)
  })
})
