/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext, resolveConstrainedPath, assertExternalDirectory } from "../types.js"
import { matchGlob, walkFiles } from "../file-edit/fs-walk.js"

const definition: ToolDefinition = {
  name: "glob",
  description: "Find files by name pattern. Supports * and ** (e.g. 'src/**/*.ts'). Returns matching relative paths.",
  parameters: {
    type: "object",
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "Glob pattern to match file paths against." },
      path: { type: "string", description: "Base directory. Default: project root." },
      max_results: { type: "integer", description: "Maximum results. Default 500." },
    },
  },
}

const DEFAULT_MAX_RESULTS = 500
const MAX_MAX_RESULTS = 2000

export function createGlobTool(): Tool {
  return {
    definition,
    async execute(_id, args, signal, _update, context) {
      try {
        if (signal?.aborted) return textResult("aborted", true)
        const ctx = context as ToolContext
        const pattern = String(args.pattern ?? "")
        if (!pattern) return textResult("Missing 'pattern'.", true)

        const rawBase = typeof args.path === "string" ? args.path : "."
        let base: string
        try {
          base = resolveConstrainedPath(path.resolve(ctx.cwd, rawBase), ctx.cwd)
        } catch (error) {
          return textResult(`Access denied: ${error instanceof Error ? error.message : String(error)}`, true)
        }

        let maxResults = typeof args.max_results === "number" ? Math.max(1, args.max_results) : DEFAULT_MAX_RESULTS
        if (maxResults > MAX_MAX_RESULTS) maxResults = MAX_MAX_RESULTS

        assertExternalDirectory(base, ctx.cwd)

        const results: string[] = []
        walkFiles(base, (_abs, rel) => {
          if (results.length >= maxResults) return
          if (signal?.aborted) return
          if (!matchGlob(pattern, rel)) return
          results.push(rel)
        })
        if (signal?.aborted) return textResult("aborted", true)
        if (results.length === 0) return textResult(`No files matched '${pattern}'`)
        return textResult(`${results.length} file(s):\n${results.join("\n")}`)
      } catch (error) {
        return textResult(`Glob error: ${error instanceof Error ? error.message : String(error)}`, true)
      }
    },
  }
}
