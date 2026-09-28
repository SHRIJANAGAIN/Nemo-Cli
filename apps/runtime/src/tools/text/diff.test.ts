/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { applyUnifiedPatch, createDiffTool, createPatchTool, diffLines, unifiedDiff } from "./diff.js"
import type { ToolResult } from "../../../../../packages/protocol/src/index.js"

const ops = (a: string[], b: string[]): string[] => diffLines(a, b).map((o) => `${o.op}${o.line}`)

describe("diffLines", () => {
  it("marks identical inputs as unchanged", () => {
    expect(ops(["x", "y"], ["x", "y"])).toEqual([" x", " y"])
  })

  it("emits delete before insert for a replaced line", () => {
    expect(ops(["l1", "l2", "l3"], ["l1", "lX", "l3"])).toEqual([" l1", "-l2", "+lX", " l3"])
  })

  it("emits trailing insertions when the right side grows", () => {
    expect(ops(["x"], ["x", "y"])).toEqual([" x", "+y"])
  })

  it("emits trailing deletions when the right side shrinks", () => {
    expect(ops(["x", "y"], ["x"])).toEqual([" x", "-y"])
  })

  it("treats an empty side as pure insertion or deletion", () => {
    expect(ops([], ["a", "b"])).toEqual(["+a", "+b"])
    expect(ops(["a", "b"], [])).toEqual(["-a", "-b"])
  })
})

describe("unifiedDiff", () => {
  const ten = Array.from({ length: 10 }, (_, i) => `l${i}`)
  const withChange = ten.map((l, i) => (i === 5 ? "X5" : l))

  it("returns a marker when there are no differences", () => {
    expect(unifiedDiff("a.txt", "b.txt", ["same"], ["same"])).toBe("(no differences)")
  })

  it("emits file headers and a hunk with context", () => {
    const out = unifiedDiff("a.txt", "b.txt", ["l1", "l2", "l3"], ["l1", "lX", "l3"])
    expect(out).toBe("--- a.txt\n+++ b.txt\n@@ -1,3 +1,3 @@\n l1\n-l2\n+lX\n l3")
  })

  it("narrows the hunk when context is reduced", () => {
    const wide = unifiedDiff("a.txt", "b.txt", ten, withChange, 3)
    const narrow = unifiedDiff("a.txt", "b.txt", ten, withChange, 1)
    expect(wide.startsWith("--- a.txt\n+++ b.txt\n")).toBe(true)
    expect(narrow.startsWith("--- a.txt\n+++ b.txt\n")).toBe(true)
    expect(wide).toContain("-l5")
    expect(narrow).toContain("-l5")
    expect(narrow).toContain("@@ -5,2 +5,2 @@")
    expect(narrow).not.toContain(" l2")
    expect(wide).toContain(" l2")
    expect(wide.length).toBeGreaterThan(narrow.length)
  })

  it("splits distant changes into separate hunks", () => {
    const a = Array.from({ length: 10 }, (_, i) => `l${i}`)
    const b = a.map((l, i) => (i === 1 || i === 8 ? l.toUpperCase() : l))
    const out = unifiedDiff("a.txt", "b.txt", a, b)
    const hunks = out.split("\n").filter((l) => l.startsWith("@@"))
    expect(hunks.length).toBe(2)
    expect(out).toContain("-l1")
    expect(out).toContain("-l8")
  })
})

describe("applyUnifiedPatch", () => {
  it("round-trips a replacement patch produced by unifiedDiff", () => {
    const a = ["l1", "l2", "l3"]
    const b = ["l1", "lX", "l3"]
    const patch = unifiedDiff("a.txt", "b.txt", a, b)
    expect(applyUnifiedPatch("l1\nl2\nl3", patch)).toBe("l1\nlX\nl3")
  })

  it("applies multiple hunks in reverse order with correct positions", () => {
    const patch = ["diff --git a/f.txt b/f.txt", "@@ -1,1 +1,1 @@", "-l1", "+L1", "@@ -5,1 +5,1 @@", "-l5", "+L5"].join(
      "\n",
    )
    expect(applyUnifiedPatch("l1\nl2\nl3\nl4\nl5", patch)).toBe("L1\nl2\nl3\nl4\nL5")
  })

  it("rejects a patch whose context does not match the file", () => {
    const patch = "@@ -1,1 +1,1 @@\n WRONG"
    expect(() => applyUnifiedPatch("l1", patch)).toThrow(
      'patch context mismatch at line 1: expected "WRONG", found "l1"',
    )
  })

  it("reports <eof> when the patch runs past the end of the file", () => {
    const patch = "@@ -1,2 +1,2 @@\n l1\n l2"
    expect(() => applyUnifiedPatch("l1", patch)).toThrow(
      'patch context mismatch at line 2: expected "l2", found "<eof>"',
    )
  })

  it("falls back to full-file replacement when no @@ hunks are present", () => {
    const patch = "--- old\n+++ new\n ctx\n- old\n+ new"
    // Only the leading op character is stripped, so "+ new" keeps its space.
    expect(applyUnifiedPatch("anything", patch)).toBe("ctx\n new")
  })

  it("throws when the patch has no @@ hunks and is not a replacement", () => {
    expect(() => applyUnifiedPatch("content", "not a patch")).toThrow("no @@ hunks found in patch")
  })
})

describe("diff and patch tools", () => {
  let tmp = ""
  let originalCwd = ""

  beforeEach(() => {
    originalCwd = process.cwd()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-diff-"))
    process.chdir(tmp)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const runDiff = async (args: Record<string, unknown>): Promise<ToolResult> =>
    createDiffTool().execute("call-1", args, undefined)

  const runPatch = async (args: Record<string, unknown>): Promise<ToolResult> =>
    createPatchTool().execute("call-1", args, undefined)

  const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text

  it("diffs a file against inline text", async () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "one\ntwo\n", "utf8")
    const res = await runDiff({ file_a: "a.txt", text_b: "one\nTWO\n" })
    expect(res.isError).toBe(false)
    const lines = textOf(res).split("\n")
    expect(lines[0]).toBe("--- a.txt")
    expect(lines[1]).toBe("+++ <text>")
    expect(lines[2]).toMatch(/^@@ -1,\d \+1,\d @@$/)
    expect(lines).toContain("-two")
    expect(lines).toContain("+TWO")
  })

  it("diffs two files and names the second file in the header", async () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "one\n", "utf8")
    fs.writeFileSync(path.join(tmp, "b.txt"), "two\n", "utf8")
    const res = await runDiff({ file_a: "a.txt", file_b: "b.txt" })
    expect(textOf(res).split("\n")[1]).toBe("+++ b.txt")
  })

  it("reports when neither file_b nor text_b is provided", async () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "one\n", "utf8")
    const res = await runDiff({ file_a: "a.txt" })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toBe("Provide either file_b or text_b to diff against.")
  })

  it("reports (no differences) for identical inputs", async () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "same\n", "utf8")
    const res = await runDiff({ file_a: "a.txt", text_b: "same\n" })
    expect(textOf(res)).toBe("(no differences)")
  })

  it("wraps read failures as diff failed", async () => {
    const res = await runDiff({ file_a: "missing.txt", text_b: "x" })
    expect(res.isError).toBe(true)
    expect(textOf(res).startsWith("diff failed:")).toBe(true)
  })

  it("applies a generated patch to a file and reports line counts", async () => {
    const content = "l1\nl2\nl3"
    fs.writeFileSync(path.join(tmp, "a.txt"), content, "utf8")
    const patch = unifiedDiff("a.txt", "b.txt", content.split("\n"), ["l1", "lX", "l3"])
    const res = await runPatch({ file: "a.txt", patch })
    expect(res.isError).toBe(false)
    expect(textOf(res)).toBe("Patched a.txt: 3 -> 3 lines")
    expect(fs.readFileSync(path.join(tmp, "a.txt"), "utf8")).toBe("l1\nlX\nl3")
  })

  it("treats a patch with no net change as a clean no-op", async () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "l1", "utf8")
    const res = await runPatch({ file: "a.txt", patch: "@@ -1,1 +1,1 @@\n l1" })
    expect(textOf(res)).toBe("Patch applied cleanly but produced no changes.")
    expect(fs.readFileSync(path.join(tmp, "a.txt"), "utf8")).toBe("l1")
  })

  it("reports malformed patches as errors", async () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "l1", "utf8")
    const res = await runPatch({ file: "a.txt", patch: "garbage" })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toBe("patch failed: no @@ hunks found in patch")
  })

  it("wraps read failures as patch failed", async () => {
    const res = await runPatch({ file: "missing.txt", patch: "@@ -1,1 +1,1 @@\n l1" })
    expect(res.isError).toBe(true)
    expect(textOf(res).startsWith("patch failed:")).toBe(true)
  })
})
