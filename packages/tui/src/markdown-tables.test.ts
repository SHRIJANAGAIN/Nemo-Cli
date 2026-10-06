/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { displayWidth, isSeparatorRow, isTableRow, normalizeTables } from "./markdown-tables.js"

/** Every rendered row must be the same terminal width — that is the whole point. */
function widthsOf(table: string): number[] {
  return table
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => displayWidth(l))
}

describe("displayWidth", () => {
  it("counts ASCII as one cell per character", () => {
    expect(displayWidth("abc")).toBe(3)
  })

  it("counts CJK as two cells, which .length gets wrong", () => {
    expect(displayWidth("日本")).toBe(4)
    expect("日本".length).toBe(2)
  })

  it("ignores combining marks", () => {
    expect(displayWidth("é")).toBe(1)
  })

  it("counts emoji as two cells", () => {
    expect(displayWidth("🙂")).toBe(2)
  })
})

describe("row predicates", () => {
  it("recognises a separator row", () => {
    expect(isSeparatorRow("|---|---|")).toBe(true)
    expect(isSeparatorRow("| :--- | ---: |")).toBe(true)
  })

  it("rejects a header row as a separator", () => {
    expect(isSeparatorRow("| a | b |")).toBe(false)
  })

  it("recognises a table row", () => {
    expect(isTableRow("| a | b |")).toBe(true)
    expect(isTableRow("just text")).toBe(false)
  })
})

describe("normalizeTables", () => {
  it("pads a ragged table so every row is the same width", () => {
    const input = ["| name | id |", "|---|---|", "| alpha | 1 |", "| b | 22 |"].join("\n")
    const out = normalizeTables(input)
    const widths = new Set(widthsOf(out))
    expect(widths.size).toBe(1)
  })

  it("keeps cell content intact", () => {
    const out = normalizeTables(["| h1 | h2 |", "|---|---|", "| keep me | x |"].join("\n"))
    expect(out).toContain("keep me")
    expect(out).toContain("h1")
  })

  it("aligns CJK columns by display width, not string length", () => {
    const input = ["| 名前 | id |", "|---|---|", "| 日本 | 1 |", "| ab | 22 |"].join("\n")
    const out = normalizeTables(input)
    expect(new Set(widthsOf(out)).size).toBe(1)
  })

  it("leaves prose outside tables exactly as it was", () => {
    const input = "Some prose.\n\nMore prose with a | pipe inside."
    expect(normalizeTables(input)).toBe(input)
  })

  it("does not treat a lone pipe line as a table", () => {
    // No separator row follows, so this is prose containing a pipe.
    expect(normalizeTables("a | b")).toBe("a | b")
  })

  it("handles several tables in one answer", () => {
    const input = [
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "text between",
      "",
      "| c | d |",
      "|---|---|",
      "| 333333333 | 4 |",
    ].join("\n")
    const out = normalizeTables(input)
    expect(out).toContain("text between")
    expect(out).toContain("333333333")
    expect(new Set(widthsOf(out.split("\n\n")[0] ?? "")).size).toBe(1)
  })

  it("survives rows with missing trailing cells", () => {
    const input = ["| a | b | c |", "|---|---|---|", "| 1 |"].join("\n")
    const out = normalizeTables(input)
    expect(out).toContain("1")
    expect(new Set(widthsOf(out)).size).toBe(1)
  })

  it("treats an escaped pipe as cell content, not a delimiter", () => {
    const out = normalizeTables(["| a | b |", "|---|---|", "| x \\| y | z |"].join("\n"))
    expect(out).toContain("x | y")
  })

  it("is idempotent — running it twice changes nothing", () => {
    const input = ["| name | id |", "|---|---|", "| alpha | 1 |"].join("\n")
    const once = normalizeTables(input)
    expect(normalizeTables(once)).toBe(once)
  })

  it("leaves an empty string alone", () => {
    expect(normalizeTables("")).toBe("")
  })
})
