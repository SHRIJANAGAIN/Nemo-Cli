/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { createCsvTool, parseCsv } from "./csv.js"
import type { ToolResult } from "../../../../../packages/protocol/src/index.js"

describe("parseCsv", () => {
  it("parses simple rows and columns", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ])
  })

  it("keeps commas inside quoted fields", () => {
    expect(parseCsv('a,b\n"c,d",e')).toEqual([
      ["a", "b"],
      ["c,d", "e"],
    ])
  })

  it("unescapes doubled quotes as a literal quote", () => {
    expect(parseCsv('"say ""hi""",x')).toEqual([['say "hi"', "x"]])
  })

  it("handles CRLF and lone CR line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ])
    expect(parseCsv("a\rb")).toEqual([["a"], ["b"]])
  })

  it("accepts a custom delimiter", () => {
    expect(parseCsv("a\tb\n1\t2", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ])
  })

  it("allows newlines inside quoted fields", () => {
    expect(parseCsv('"line1\nline2",x')).toEqual([["line1\nline2", "x"]])
  })

  it("treats a quote that does not start a field as a literal", () => {
    expect(parseCsv('a"b,c')).toEqual([['a"b', "c"]])
  })

  it("emits a final row when the input has no trailing newline", () => {
    expect(parseCsv("a,b")).toEqual([["a", "b"]])
  })

  it("does not add a phantom row after a trailing newline", () => {
    expect(parseCsv("a\n")).toEqual([["a"]])
  })

  it("preserves empty fields", () => {
    expect(parseCsv("a,,c")).toEqual([["a", "", "c"]])
  })

  it("returns no rows for empty input", () => {
    expect(parseCsv("")).toEqual([])
  })
})

describe("csv tool", () => {
  let tmp = ""
  let originalCwd = ""

  beforeEach(() => {
    originalCwd = process.cwd()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-csv-"))
    process.chdir(tmp)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const run = async (args: Record<string, unknown>): Promise<ToolResult> =>
    createCsvTool().execute("call-1", args, undefined)

  const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text

  it("renders a markdown table with padded columns", async () => {
    fs.writeFileSync(path.join(tmp, "t.csv"), "ab,cd\ne,f\n", "utf8")
    const res = await run({ file: "t.csv" })
    expect(res.isError).toBe(false)
    expect(textOf(res)).toBe("| ab | cd |\n|:::::::::|\n| e  | f  |")
  })

  it("limits output to the requested number of rows", async () => {
    fs.writeFileSync(path.join(tmp, "t.csv"), "a,b\n1,2\n3,4\n5,6\n", "utf8")
    const res = await run({ file: "t.csv", head: 2 })
    const text = textOf(res)
    expect(text).toContain("| 1  | 2  |")
    expect(text).not.toContain("| 3  | 4  |")
    expect(text).not.toContain("| 5  | 6  |")
  })

  it("clamps head to at least one row", async () => {
    fs.writeFileSync(path.join(tmp, "t.csv"), "a,b\n1,2\n", "utf8")
    const res = await run({ file: "t.csv", head: 0 })
    const text = textOf(res)
    expect(text).toContain("| a  | b  |")
    expect(text).not.toContain("| 1  | 2  |")
  })

  it("parses TSV files with the delimiter argument", async () => {
    fs.writeFileSync(path.join(tmp, "t.tsv"), "name\tvalue\nfoo\tbar\n", "utf8")
    const res = await run({ file: "t.tsv", delimiter: "\t" })
    const text = textOf(res)
    expect(text).toContain("| name | value |")
    expect(text).toContain("| foo  | bar   |")
  })

  it("caps rendered data at 200 rows with a remainder marker", async () => {
    const rows = ["h1,h2"]
    for (let i = 0; i < 203; i++) rows.push(`${i},x`)
    fs.writeFileSync(path.join(tmp, "big.csv"), rows.join("\n") + "\n", "utf8")
    const res = await run({ file: "big.csv" })
    expect(textOf(res)).toContain("… 3 more rows")
  })

  it("reports an empty file without rendering a table", async () => {
    fs.writeFileSync(path.join(tmp, "empty.csv"), "", "utf8")
    const res = await run({ file: "empty.csv" })
    expect(res.isError).toBe(false)
    expect(textOf(res)).toBe("(empty file)")
  })

  it("fails with a clear error for a missing file", async () => {
    const res = await run({ file: "nope.csv" })
    expect(res.isError).toBe(true)
    expect(textOf(res).startsWith("csv failed:")).toBe(true)
  })
})

describe("csv tool byte cap", () => {
  let tmp = ""
  let originalCwd = ""

  beforeEach(() => {
    originalCwd = process.cwd()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-csvcap-"))
    process.chdir(tmp)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const run = async (args: Record<string, unknown>): Promise<ToolResult> =>
    createCsvTool().execute("call-1", args, undefined)

  const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text

  it("reads only a bounded prefix of a huge CSV and says so", async () => {
    fs.writeFileSync(path.join(tmp, "huge.csv"), "h1,h2\n" + "a,b\n".repeat(1_400_000))
    const res = await run({ file: "huge.csv" })
    expect(res.isError).toBe(false)
    const text = textOf(res)
    expect(text).toContain("| h1 | h2 |")
    expect(text).toContain("truncated")
  })
})
