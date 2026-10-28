/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Markdown table normalisation.
 *
 * A model emitting a pipe table almost never pads its cells, so what reaches
 * the terminal is whatever the model typed:
 *
 *     | a | b |
 *     |---|---|
 *     | 1 | 2 |
 *
 * Rendered as-is, every column is as wide as its widest cell and nothing lines
 * up — the table reads as noise. Worse, CJK and emoji cells are DOUBLE width in
 * a terminal but count as one in `String.length`, so any width computed with
 * `.length` misaligns every column after the first wide glyph.
 *
 * This rewrites a pipe table to fixed-width columns using terminal display
 * width, which is what makes the borders line up in a real terminal.
 */

/** Leading/trailing whitespace and pipes that carry no content. */
const EDGE_PIPE = /^\s*\|?|\|?\s*$/g

/** Cells wrapped in backticks/code spans measure as their inner text. */
function cellText(raw: string): string {
  return raw.replace(EDGE_PIPE, "").trim()
}

/** Split one table row into cells, honouring `\|` as a literal pipe. */
function splitRow(line: string): string[] {
  const out: string[] = []
  let current = ""
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === "\\" && line[i + 1] === "|") {
      current += "|"
      i++
      continue
    }
    if (ch === "|") {
      out.push(current)
      current = ""
      continue
    }
    current += ch
  }
  out.push(current)
  return out
}

/**
 * True for the `|---|---|` separator row.
 *
 * The leading and trailing pipes produce EMPTY edge cells (`"|---|"` splits to
 * `["", "---", "---", ""]`), so blanks are dropped before the shape check —
 * otherwise the most ordinary separator row in Markdown fails to recognise
 * itself and the table is left ragged.
 */
export function isSeparatorRow(line: string): boolean {
  const cells = splitRow(line)
    .map(cellText)
    .filter((t) => t.length > 0)
  if (cells.length === 0) return false
  return cells.every((t) => /^:?-{1,}:?$/.test(t))
}

/** True when a line looks like the start of a pipe table. */
export function isTableRow(line: string): boolean {
  const t = line.trim()
  return t.includes("|") && t.replace(EDGE_PIPE, "") !== ""
}

/**
 * The real cells of a table row.
 *
 * `"| a | b |"` splits into five pieces — the leading and trailing pipes leave
 * empty strings at both ends — so the raw split must have its edges trimmed
 * before the pieces count as columns. Missing that inflates every table by two
 * blank columns, which is also why normalising twice kept changing the result.
 */
function rowCells(line: string): string[] {
  const cells = splitRow(line).map(cellText)
  let start = 0
  let end = cells.length
  while (start < end && cells[start] === "") start++
  while (end > start && cells[end - 1] === "") end--
  return cells.slice(start, end)
}

/**
 * Display width of a string in terminal cells.
 *
 * Counts East Asian Wide/Fullwidth and emoji as two columns, combining marks as
 * zero, and treats a tab as a fixed run — the same rules a terminal applies.
 * `.length` is wrong for all three cases, which is exactly why tables drift.
 */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0x09) {
      width += 4 - (width % 4)
      continue
    }
    // Combining marks and zero-width joiners occupy no cell of their own.
    if (code >= 0x0300 && code <= 0x036f) continue
    if (code === 0x200d) continue
    if (code >= 0xfe00 && code <= 0xfe0f) continue
    width += isWide(code) ? 2 : 1
  }
  return width
}

/** Wide ranges per Unicode East Asian Width (W/F) plus common emoji blocks. */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)))
}

/**
 * Rewrite one pipe table to fixed-width columns. Non-table text and
 * non-contiguous table lines are returned untouched, so this is safe to run over
 * a whole streamed answer.
 */
export function normalizeTables(text: string): string {
  const lines = text.split("\n")
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    // A table needs a header row followed by a separator row.
    if (i + 1 < lines.length && isTableRow(lines[i] ?? "") && isSeparatorRow(lines[i + 1] ?? "")) {
      const header = rowCells(lines[i] ?? "")
      const body: string[][] = []
      let j = i + 2
      while (j < lines.length && isTableRow(lines[j] ?? "")) {
        body.push(rowCells(lines[j] ?? ""))
        j++
      }
      const columns = Math.max(header.length, ...body.map((r) => r.length), 1)
      const widths: number[] = []
      for (let c = 0; c < columns; c++) {
        let w = displayWidth(header[c] ?? "")
        for (const row of body) w = Math.max(w, displayWidth(row[c] ?? ""))
        widths[c] = Math.max(1, w)
      }
      // Iterate the COLUMN count, not the row's own cell count: a row that omits
      // trailing cells (`| 1 |` under a three-column header) must still be
      // emitted with every column, or the table ends up ragged again — which is
      // the exact defect this exists to remove.
      const line = (cells: string[]): string => `| ${widths.map((w, c) => pad(cells[c] ?? "", w)).join(" | ")} |`
      out.push(line(header))
      out.push(`|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`)
      for (const row of body) out.push(line(row))
      i = j
      continue
    }
    out.push(lines[i] ?? "")
    i++
  }
  return out.join("\n")
}
