/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { Tool } from "../types.js"
import { textResult, resolveConstrainedPath } from "../types.js"
import { MAX_TEXT_FILE_BYTES, readFileTextCapped } from "./capped-read.js"

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
      timeoutMs: 30_000,
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
    async execute(_id, args, _signal, _update, context) {
      try {
        // Respect the tool context (worktree/subdir sessions) like the sibling
        // text tools — resolving against process.cwd() failed sessions whose
        // cwd is a subtree of the repo root.
        const p = resolveConstrainedPath(String(args.file), context?.cwd ?? process.cwd())
        const capped = readFileTextCapped(p)
        let src = capped.text
        if (capped.truncated) {
          const nl = src.lastIndexOf("\n")
          src = nl >= 0 ? src.slice(0, nl + 1) : "" // drop the torn tail row
        }
        const rows = parseCsv(src, String(args.delimiter ?? ","))
        const note = capped.truncated
          ? `\n… source truncated at ${MAX_TEXT_FILE_BYTES} bytes of ${capped.totalBytes}`
          : ""
        if (rows.length === 0)
          return textResult(
            capped.truncated
              ? `(no complete rows in the first ${MAX_TEXT_FILE_BYTES} bytes of ${capped.totalBytes})`
              : "(empty file)",
          )
        const head = typeof args.head === "number" ? Math.max(1, args.head) : rows.length
        return textResult(toMarkdownTable(rows.slice(0, head)) + note)
      } catch (e) {
        return textResult(`csv failed: ${e instanceof Error ? e.message : String(e)}`, /*isError*/ true)
      }
    },
  }
}
