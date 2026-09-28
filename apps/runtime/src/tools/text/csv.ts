/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { Tool } from "../types.js"
import { textResult, resolveConstrainedPath } from "../types.js"
import * as fs from "fs"

/** Parse CSV treating quoted fields correctly (RFC-4180-ish). */
export function parseCsv(text: string, delim = ","): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
      } else {
        field += ch
        i++
      }
    } else if (ch === '"' && field === "") {
      inQuotes = true
      i++
    } else if (ch === delim) {
      row.push(field)
      field = ""
      i++
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      row.push(field)
      rows.push(row)
      row = []
      field = ""
      i++
    } else {
      field += ch
      i++
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Convert parsed CSV rows into a readable markdown table. */
function toMarkdownTable(rows: string[][]): string {
  if (rows.length === 0) return "(empty)"
  const widths = rows[0].map((_, c) => rows.reduce((w, r) => Math.max(w, (r[c] ?? "").length), 2))
  const rule = (left: string, mid: string, right: string) =>
    left + widths.map((w) => mid.repeat(w + 2)).join(mid) + right
  const fmt = (r: string[]) => "| " + widths.map((w, c) => (r[c] ?? "").padEnd(w)).join(" | ") + " |"
  const lines = [fmt(rows[0]), rule("|", ":", "|"), ...rows.slice(1, 201).map(fmt)]
  if (rows.length > 201) lines.push(`… ${rows.length - 201} more rows`)
  return lines.join("\n")
}

export function createCsvTool(): Tool {
  return {
    definition: {
      name: "csv",
      description:
        "Read a CSV/TSV file and render it as a markdown table, or query rows by header. Useful for inspecting datasets, exports, and config dumps.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "Path to the CSV file" },
          delimiter: { type: "string", description: "Field delimiter, default comma" },
          head: { type: "number", description: "Only show the first N rows" },
        },
        required: ["file"],
      },
    },
    async execute(_id, args) {
      try {
        const p = resolveConstrainedPath(String(args.file), process.cwd())
        const text = fs.readFileSync(p, "utf8")
        const rows = parseCsv(text, String(args.delimiter ?? ","))
        if (rows.length === 0) return textResult("(empty file)")
        const head = typeof args.head === "number" ? Math.max(1, args.head) : rows.length
        return textResult(toMarkdownTable(rows.slice(0, head)))
      } catch (e) {
        return textResult(`csv failed: ${e instanceof Error ? e.message : String(e)}`, true)
      }
    },
  }
}
