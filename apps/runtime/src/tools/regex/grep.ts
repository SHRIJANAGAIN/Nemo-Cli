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
  assertExternalDirectory,
  accessDeniedMessage,
} from "../types.js"
import { matchGlob, walkFiles } from "../file-edit/fs-walk.js"
import { searchRipgrep, type RgHit } from "../search/ripgrep.js"
import { resolveSearchRoot } from "../search/search-root.js"

const definition: ToolDefinition = {
  timeoutMs: 30_000,
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

/**
 * Render ripgrep hits in the exact shape the Node walker produces:
 * `rel:line: text` for matches, indented `  rel:line: text` for context
 * lines, capped at `maxResults` matches.
 */
export function formatGrepHits(
  hits: RgHit[],
  opts: { maxResults: number; contextLines: number },
): { lines: string[]; matchCount: number; hasMore: boolean } {
  const lines: string[] = []
  let matchCount = 0
  let hasMore = false
  const trunc = (s: string): string =>
    s.length > MAX_TEST_LINE_LENGTH ? `${s.slice(0, MAX_TEST_LINE_LENGTH)}… [line truncated]` : s
  for (const h of hits) {
    if (h.isMatch) {
      if (matchCount >= opts.maxResults) {
        hasMore = true
        break
      }
      matchCount++
      lines.push(`${h.path}:${h.line}: ${trunc(h.text.trim())}`)
    } else if (opts.contextLines > 0 && matchCount < opts.maxResults) {
      // rg emits context only adjacent to matches — both the lines before
      // a match (they arrive first) and after it. Drop only once the
      // match cap has been reached, mirroring the Node walker.
      lines.push(`  ${h.path}:${h.line}: ${trunc(h.text.trim())}`)
    }
  }
  return { lines, matchCount, hasMore }
}

export function createGrepTool(): Tool {
  return {
    definition,
    async execute(_id, args, signal, _update, context) {
      try {
        if (signal?.aborted) return textResult("aborted", /*isError*/ true)
        const ctx = context as ToolContext
        const pattern = String(args.pattern ?? "")
        if (!pattern) return textResult("Missing 'pattern'.", /*isError*/ true)

        const rawBase = typeof args.path === "string" ? args.path : "."
        let base: string
        try {
          base = resolveConstrainedPath(path.resolve(ctx.cwd, rawBase), ctx.cwd)
        } catch (error) {
          return textResult(
            accessDeniedMessage(error),
            /*isError*/ true,
          )
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
          return textResult(`Invalid regular expression: ${pattern}`, /*isError*/ true)
        }

        // ── ripgrep fast path: gitignore-aware, 10-50x the Node walk.
        //    Any failure (missing binary, rejected pattern, timeout) keeps
        //    the pure-Node walk below as the fallback. ──
        const root = resolveSearchRoot(base)
        const rg = await searchRipgrep(
          {
            cwd: root.cwd,
            target: root.target,
            pattern,
            fixedStrings: literal,
            ignoreCase: Boolean(args.ignore_case),
            contextLines: contextLines > 0 ? contextLines : undefined,
            glob,
          },
          { signal },
        )
        if (rg.kind === "ok") {
          if (signal?.aborted) return textResult("aborted", /*isError*/ true)
          const { lines, matchCount, hasMore } = formatGrepHits(rg.hits, { maxResults, contextLines })
          if (matchCount === 0) {
            return textResult(`No matches for /${pattern}/ in ${base}`)
          }
          const header = `Found ${matchCount} match(es)${hasMore ? " (more matches available)" : ""}`
          return textResult(`${header}\n${lines.join("\n")}`)
        }

        const results: string[] = []
        let total = 0
        let skippedLong = 0
        const abort = () => signal?.aborted ?? false
        const scanFile = (abs: string, rel: string): void => {
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
        }
        // A file target is scanned directly — the walker only ever yields
        // files inside a directory.
        if (root.isFile && root.file) {
          scanFile(root.file, path.basename(root.file))
        } else {
          walkFiles(base, (abs, rel) => scanFile(abs, rel))
        }

        if (signal?.aborted) return textResult("aborted", /*isError*/ true)
        if (results.length === 0) {
          const skipped =
            skippedLong > 0 ? ` (${skippedLong} over-long line(s) skipped — see MAX_TEST_LINE_LENGTH)` : ""
          return textResult(`No matches for /${pattern}/ in ${base}${skipped}`)
        }
        // Both loops break AT the cap (`total >= maxResults`, `results.length >=
        // maxResults`), so `total > maxResults` could NEVER be true and the
        // model was told a truncated search was complete. Match the ripgrep
        // path's `matchCount >= maxResults` contract: reaching the cap means
        // more matches may exist beyond it.
        const hasMore = total >= maxResults
        const header = `Found ${total} match(es)${hasMore ? " (more matches available)" : ""}`
        return textResult(`${header}\n${results.join("\n")}`)
      } catch (error) {
        return textResult(`Grep error: ${error instanceof Error ? error.message : String(error)}`, /*isError*/ true)
      }
    },
  }
}
