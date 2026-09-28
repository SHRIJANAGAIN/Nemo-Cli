/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext, resolveConstrainedPath } from "../types.js"

const definition: ToolDefinition = {
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
      if (!rawPath) return textResult("Missing 'notebook_path'.", true)
      if (!cellId) return textResult("Missing 'cell_id'.", true)
      let target: string
      try {
        target = resolveConstrainedPath(rawPath, ctx.cwd)
      } catch (err) {
        return textResult(`Access denied: ${err instanceof Error ? err.message : String(err)}`, true)
      }
      if (!fs.existsSync(target)) return textResult(`Notebook not found: ${rawPath}`, true)
      let notebook: {
        cells: Array<{ cell_type?: string; id?: string; source?: unknown; metadata?: Record<string, unknown> }>
      }
      try {
        notebook = JSON.parse(fs.readFileSync(target, "utf8")) as typeof notebook
      } catch (err) {
        return textResult(`Failed to parse notebook: ${err instanceof Error ? err.message : String(err)}`, true)
      }
      const cell = notebook.cells.find((c) => c.id === cellId)
      if (!cell) return textResult(`Cell not found: ${cellId}`, true)
      const newSource = String(args.new_source ?? "")
      const cellType = args.cell_type ? String(args.cell_type) : (cell.cell_type ?? "code")
      cell.cell_type = cellType
      cell.source = newSource.split("\n").map((line) => line + "\n")
      fs.writeFileSync(target, JSON.stringify(notebook, null, 1), "utf8")
      return textResult(`Edited cell ${cellId} in ${rawPath}.`)
    },
  }
}
