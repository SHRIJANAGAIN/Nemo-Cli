/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import {
  textResult,
  type Tool,
  type ToolContext,
  resolveConstrainedPath,
  assertMutablePath,
  assertExternalDirectory,
} from "../types.js"
import { syntaxNote } from "../diagnostics/tsc-diagnostics.js"

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "write_file",
  description:
    "Create or overwrite a file with the given content. Creates parent directories as needed. Use for new files or full rewrites. .git and .trayambak directories are read-only metadata: writes to them are rejected.",
  parameters: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: { type: "string", description: "Relative or absolute path to the file." },
      content: { type: "string", description: "Full file content to write." },
    },
  },
}

export function createWriteFileTool(): Tool {
  return {
    definition,
    async execute(_id, args, signal, _update, context) {
      try {
        if (signal?.aborted) return textResult("aborted", /*isError*/ true)
        const ctx = context as ToolContext
        const rawPath = String(args.path ?? "")
        const content = String(args.content ?? "")
        if (!rawPath) return textResult("Missing 'path'.", /*isError*/ true)

        let target: string
        try {
          target = resolveConstrainedPath(rawPath, ctx.cwd)
          assertExternalDirectory(target, ctx.cwd)
          assertMutablePath(target)
        } catch (error) {
          return textResult(
            `Access denied: ${error instanceof Error ? error.message : String(error)}`,
            /*isError*/ true,
          )
        }

        if (signal?.aborted) return textResult("aborted", /*isError*/ true)

        if (ctx.requestPermission) {
          const ok = await ctx.requestPermission("write_file", rawPath, "Trayambak approval required for write_file")
          if (!ok) return textResult("Permission denied for write_file: " + rawPath, /*isError*/ true)
        }

        if (signal?.aborted) return textResult("aborted", /*isError*/ true)

        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, content, "utf8")
        const lines = content.split("\n").length
        // LSP-lite: surface syntax errors in the written file immediately.
        const note = await syntaxNote(target, content)
        return textResult(`Wrote ${lines} lines to ${rawPath}${note}`)
      } catch (error) {
        return textResult(`Write error: ${error instanceof Error ? error.message : String(error)}`, /*isError*/ true)
      }
    },
  }
}
