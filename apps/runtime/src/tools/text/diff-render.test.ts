/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import {
  diffStatLine,
  miniDiff,
  parseUnifiedDiff,
  renderDiffFiles,
  renderFileDiff,
  truncateMiddleLines,
} from "./diff-render.js"

const SAMPLE = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -10,3 +10,4 @@",
  " context",
  "-old();",
  "+new1();",
  "+new2();",
  "@@ -20,2 +21,2 @@",
  " keep",
  "-gone();",
  "+here();",
].join("\n")

describe("parseUnifiedDiff", () => {
  it("parses files, hunks, line numbers, and add/del counts", () => {
    const files = parseUnifiedDiff(SAMPLE)
    expect(files.length).toBe(1)
    const f = files[0] as {
      path: string
      adds: number
      dels: number
      hunks: Array<{ lines: Array<{ type: string; oldNo?: number; newNo?: number }> }>
    }
    expect(f.path).toBe("src/app.ts")
    expect(f.adds).toBe(3)
    expect(f.dels).toBe(2)
    expect(f.hunks.length).toBe(2)
    const first = f.hunks[0]?.lines ?? []
    expect(first.map((l) => l.type)).toEqual([" ", "-", "+", "+"])
    expect(first[1]?.oldNo).toBe(11)
    expect(first[2]?.newNo).toBe(11)
    expect(first[3]?.newNo).toBe(12)
  })

  it("detects added and deleted files", () => {
    const added = parseUnifiedDiff("diff --git a/n.txt b/n.txt\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+hi\n")
    expect(added[0]?.kind).toBe("added")
    const deleted = parseUnifiedDiff("diff --git a/o.txt b/o.txt\n--- a/o.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n")
    expect(deleted[0]?.kind).toBe("deleted")
  })

  it("skips no-newline markers and returns empty for garbage", () => {
    const files = parseUnifiedDiff("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n")
    expect(files.length).toBe(0) // no file header → no file
    expect(parseUnifiedDiff("just some text")).toEqual([])
    expect(parseUnifiedDiff("")).toEqual([])
  })
})

describe("renderFileDiff", () => {
  it("renders header, hunk ranges, numbered rows, and hunk spacers", () => {
    const files = parseUnifiedDiff(SAMPLE)
    const rows = renderFileDiff(files[0] as never)
    expect(rows[0]).toBe("• Edited src/app.ts (+3 -2)")
    expect(rows).toContain("@@ -10,3 +10,4 @@")
    expect(rows).toContain("-    11 old();")
    expect(rows).toContain("+    11 new1();")
    expect(rows).toContain(":")
    expect(rows).toContain("@@ -20,2 +21,2 @@")
  })

  it("caps rows with a remainder marker", () => {
    const files = parseUnifiedDiff(SAMPLE)
    const rows = renderFileDiff(files[0] as never, { maxRows: 3 })
    expect(rows.some((r) => r.startsWith("… +") && r.endsWith("more lines"))).toBe(true)
  })
})

describe("renderDiffFiles", () => {
  it("rolls up multiple files and says No changes when empty", () => {
    expect(renderDiffFiles([])).toEqual(["No changes."])
    const a = parseUnifiedDiff(SAMPLE)
    const b = parseUnifiedDiff(SAMPLE.replaceAll("src/app.ts", "src/b.ts"))
    const rows = renderDiffFiles([...a, ...b] as never)
    expect(rows[0]).toBe("Edited 2 files (+6 -4)")
    expect(rows).toContain("└ src/app.ts (+3 -2)")
  })
})

describe("diffStatLine", () => {
  it("formats the stat suffix", () => {
    expect(diffStatLine(3, 2)).toBe("(+3 -2)")
    expect(diffStatLine(0, 0)).toBe("(+0 -0)")
  })
})

describe("miniDiff", () => {
  it("lists removed then added lines with a cap marker", () => {
    expect(miniDiff("a\nb", "a\nc")).toEqual(["- a", "- b", "+ a", "+ c"])
    const out = miniDiff("a\nb\nc\nd", "w\nx\ny\nz", 4)
    expect(out.length).toBe(5)
    expect(out[4]).toContain("more lines")
  })
})

describe("truncateMiddleLines", () => {
  it("keeps head and tail with an omitted marker", () => {
    const lines = ["l0", "l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9"]
    expect(truncateMiddleLines(lines, 4, 3)).toEqual(["l0", "l1", "l2", "l3", "… +3 lines …", "l7", "l8", "l9"])
  })

  it("passes short output through untouched", () => {
    expect(truncateMiddleLines(["a", "b"], 4, 3)).toEqual(["a", "b"])
    expect(truncateMiddleLines([], 4, 3)).toEqual([])
  })
})
