/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext, resolveConstrainedPath, assertExternalDirectory } from "../types.js"
import { matchGlob, walkFiles } from "../file-edit/fs-walk.js"

const definition: ToolDefinition = {
  name: "grep",
  description:
    "Search file contents for a regular expression. Returns matching file paths with line numbers and the matched line. Respects a glob filter.",
  parameters: {
    type: "object",
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression to search for." },
      path: { type: "string", description: "Directory to search. Default: project root." },
      glob: { type: "string", description: "Only search files matching this glob (e.g. '*.ts')." },
      ignore_case: { type: "boolean", description: "Case-insensitive match. Default false." },
      max_results: { type: "integer", description: "Maximum matches to return. Default 200." },
      context: {
        type: "integer",
        description: "Number of context lines to show before and after each match (default 0).",
      },
      literal: { type: "boolean", description: "Treat pattern as plain text instead of a regex (default false)." },
    },
  },
}

const DEFAULT_MAX_RESULTS = 200
const MAX_MAX_RESULTS = 1000
/** Lines longer than this are never regex-tested: a single pathological
 *  pattern (e.g. `(a+)+$`) on a minified 100KB line blocks the event loop
 *  for minutes with no abort possible mid-test (ReDoS). Skipped lines are
 *  reported, never silently swallowed. */
const MAX_TEST_LINE_LENGTH = 8192

export function createGrepTool(): Tool {
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

        const glob = typeof args.glob === "string" ? args.glob : "*"
        const flags = args.ignore_case ? "i" : ""
        let maxResults = typeof args.max_results === "number" ? Math.max(1, args.max_results) : DEFAULT_MAX_RESULTS
        if (maxResults > MAX_MAX_RESULTS) maxResults = MAX_MAX_RESULTS
        const contextLines = typeof args.context === "number" ? Math.max(0, args.context) : 0
        const literal = Boolean(args.literal)

        assertExternalDirectory(base, ctx.cwd)

        let regex: RegExp
        try {
          const effectivePattern = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern
          regex = new RegExp(effectivePattern, flags)
        } catch {
          return textResult(`Invalid regular expression: ${pattern}`, true)
        }

        const results: string[] = []
        let total = 0
        let skippedLong = 0
        const abort = () => signal?.aborted ?? false
        walkFiles(base, (abs, rel) => {
          if (total >= maxResults) return
          if (abort()) return
          if (!matchGlob(glob, rel)) return
          let content: string
          try {
            content = fs.readFileSync(abs, "utf8")
          } catch {
            return
          }
          if (signal?.aborted) return
          const lines = content.split("\n")
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= maxResults) break
            if (signal?.aborted) break
            const line = lines[i]
            // ReDoS guard: never run user regex over mega-lines (see
            // MAX_TEST_LINE_LENGTH). Counted and reported below.
            if (line.length > MAX_TEST_LINE_LENGTH) {
              skippedLong += 1
              continue
            }
            if (regex.test(line)) {
              total++
              results.push(`${rel}:${i + 1}: ${line.trim()}`)
              if (contextLines > 0) {
                const start = Math.max(0, i - contextLines)
                const end = Math.min(lines.length, i + 1 + contextLines)
                for (let j = start; j < end; j++) {
                  if (j === i) continue
                  // Context echo is display-only: never paste megabytes of
                  // minified blob into the transcript.
                  const ctxLine = lines[j].trim()
                  results.push(
                    `  ${rel}:${j + 1}: ${ctxLine.length > MAX_TEST_LINE_LENGTH ? `${ctxLine.slice(0, MAX_TEST_LINE_LENGTH)}… [line truncated]` : ctxLine}`,
                  )
                }
              }
            }
          }
        })

        if (signal?.aborted) return textResult("aborted", true)
        if (results.length === 0) {
          const skipped =
            skippedLong > 0 ? ` (${skippedLong} over-long line(s) skipped — see MAX_TEST_LINE_LENGTH)` : ""
          return textResult(`No matches for /${pattern}/ in ${base}${skipped}`)
        }
        const hasMore = total > maxResults
        const header = `Found ${total} match(es)${hasMore ? " (more matches available)" : ""}`
        return textResult(`${header}\n${results.join("\n")}`)
      } catch (error) {
        return textResult(`Grep error: ${error instanceof Error ? error.message : String(error)}`, true)
      }
    },
  }
}
