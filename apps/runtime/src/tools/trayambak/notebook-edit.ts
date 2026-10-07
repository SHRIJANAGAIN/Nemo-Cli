/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import {
  textResult,
  type Tool,
  type ToolContext,
  resolveConstrainedPath,
  assertExternalDirectory,
  assertMutablePath,
} from "../types.js"

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "trayambak__NotebookEdit",
  description: "Edit a single cell in a Jupyter notebook (.ipynb). Replaces the cell's source.",
  parameters: {
    type: "object",
    required: ["notebook_path", "cell_id"],
    properties: {
      notebook_path: { type: "string", description: "Absolute or relative path to the .ipynb file." },
      cell_id: { type: "string", description: "Cell ID to edit." },
      new_source: { type: "string", description: "New source for the cell." },
      cell_type: { type: "string", enum: ["code", "markdown"], description: "Cell type." },
    },
  },
}

export function createNotebookEditTool(): Tool {
  return {
    definition,
    async execute(_id, args, _signal, _update, context) {
      const ctx = context as ToolContext
      const rawPath = String(args.notebook_path ?? "")
      const cellId = String(args.cell_id ?? "")
      if (!rawPath) return textResult("Missing 'notebook_path'.", /*isError*/ true)
      if (!cellId) return textResult("Missing 'cell_id'.", /*isError*/ true)
      let target: string
      try {
        target = resolveConstrainedPath(rawPath, ctx.cwd)
        assertExternalDirectory(target, ctx.cwd)
        assertMutablePath(target)
      } catch (err) {
        return textResult(`Access denied: ${err instanceof Error ? err.message : String(err)}`, /*isError*/ true)
      }
      if (!fs.existsSync(target)) return textResult(`Notebook not found: ${rawPath}`, /*isError*/ true)
      let notebook: {
        cells: Array<{ cell_type?: string; id?: string; source?: unknown; metadata?: Record<string, unknown> }>
      }
      try {
        notebook = JSON.parse(fs.readFileSync(target, "utf8")) as typeof notebook
      } catch (err) {
        return textResult(
          `Failed to parse notebook: ${err instanceof Error ? err.message : String(err)}`,
          /*isError*/ true,
        )
      }
      const cell = Array.isArray(notebook.cells) ? notebook.cells.find((c) => c.id === cellId) : undefined
      if (!cell) return textResult(`Cell not found: ${cellId}`, /*isError*/ true)
      const newSource = String(args.new_source ?? "")
      const cellType = args.cell_type ? String(args.cell_type) : (cell.cell_type ?? "code")
      cell.cell_type = cellType
      // nbformat `source` rule: every line EXCEPT the last carries "\n". The
      // old `.map(line => line + "\n")` also newline-terminated the final
      // line, so a round trip silently grew the cell ("a\nb" → "a\nb\n").
      const lines = newSource.split("\n")
      cell.source = lines.map((line, idx) => (idx === lines.length - 1 ? line : `${line}\n`))
      fs.writeFileSync(target, JSON.stringify(notebook, null, 1), "utf8")
      return textResult(`Edited cell ${cellId} in ${rawPath}.`)
    },
  }
}
