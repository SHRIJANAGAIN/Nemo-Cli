/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext, resolveConstrainedPath, assertExternalDirectory } from "../types.js"

const MAX_BYTES = 50 * 1024
const MAX_LINES = 500

const definition: ToolDefinition = {
  name: "read_file",
  description:
    "Read a text file from the project. Returns line-numbered contents. Optionally read a slice with offset/limit (1-based line numbers).",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Relative or absolute path to the file." },
      offset: { type: "integer", description: "First line to read (1-based). Default 1." },
      limit: { type: "integer", description: "Maximum number of lines to read. Default 2000." },
    },
  },
}

export function createReadFileTool(): Tool {
  return {
    definition,
    async execute(_id, args, signal, _update, context) {
      try {
        if (signal?.aborted) return textResult("aborted", true)
        const ctx = context as ToolContext
        const rawPath = String(args.path ?? "")
        if (!rawPath) return textResult("Missing 'path'.", true)

        let target: string
        try {
          target = resolveConstrainedPath(rawPath, ctx.cwd)
        } catch (error) {
          return textResult(`Access denied: ${error instanceof Error ? error.message : String(error)}`, true)
        }

        if (signal?.aborted) return textResult("aborted", true)
        assertExternalDirectory(target, ctx.cwd)

        if (!fs.existsSync(target)) return textResult(`File not found: ${rawPath}`, true)
        if (signal?.aborted) return textResult("aborted", true)
        if (!fs.statSync(target).isFile()) return textResult(`Not a file: ${rawPath}`, true)

        const offset = typeof args.offset === "number" && Number.isInteger(args.offset) ? Math.max(1, args.offset) : 1
        let limit = typeof args.limit === "number" && Number.isInteger(args.limit) ? Math.max(1, args.limit) : 2000
        if (limit > MAX_LINES) limit = MAX_LINES

        const raw = fs.readFileSync(target, "utf8")
        const byteLength = Buffer.byteLength(raw, "utf8")
        const content = byteLength > MAX_BYTES ? raw.slice(0, MAX_BYTES) : raw
        const lines = content.split("\n")
        const slice = lines.slice(offset - 1, offset - 1 + limit)
        const numbered = slice.map((line, i) => `${String(offset + i).padStart(5)} | ${line}`).join("\n")
        const more =
          lines.length > offset - 1 + limit ? `\n... (${lines.length - (offset - 1 + limit)} more lines)` : ""
        const capped = byteLength > MAX_BYTES ? `\n[content capped to ${MAX_BYTES / 1024} KB]` : ""

        return textResult(`File: ${rawPath} (${lines.length} lines)\n${numbered}${more}${capped}`)
      } catch (error) {
        return textResult(`Read error: ${error instanceof Error ? error.message : String(error)}`, true)
      }
    },
  }
}
