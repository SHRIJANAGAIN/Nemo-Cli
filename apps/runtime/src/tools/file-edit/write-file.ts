/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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
  accessDeniedMessage,
} from "../types.js"
import { syntaxNote } from "../diagnostics/tsc-diagnostics.js"

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "write_file",
  description:
    "Create or overwrite a file with the given content. Creates parent directories as needed. Use for new files or full rewrites. .git and .nemo directories are read-only metadata: writes to them are rejected.",
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
            accessDeniedMessage(error),
            /*isError*/ true,
          )
        }

        if (signal?.aborted) return textResult("aborted", /*isError*/ true)

        if (ctx.requestPermission) {
          const ok = await ctx.requestPermission("write_file", rawPath, "Nemo approval required for write_file")
          if (!ok) return textResult("Permission denied for write_file: " + rawPath, /*isError*/ true)
        }

        if (signal?.aborted) return textResult("aborted", /*isError*/ true)

        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, content, "utf8")
        // A trailing newline is a TERMINATOR, not an empty final element —
        // count like read_file does (`wc -l` semantics) so both tools agree
        // on how many lines the same file has. Empty file = 0 lines.
        const parts = content.split("\n")
        const lines = content === "" ? 0 : content.endsWith("\n") ? parts.length - 1 : parts.length
        // LSP-lite: surface syntax errors in the written file immediately.
        const note = await syntaxNote(target, content)
        return textResult(`Wrote ${lines} lines to ${rawPath}${note}`)
      } catch (error) {
        return textResult(`Write error: ${error instanceof Error ? error.message : String(error)}`, /*isError*/ true)
      }
    },
  }
}
