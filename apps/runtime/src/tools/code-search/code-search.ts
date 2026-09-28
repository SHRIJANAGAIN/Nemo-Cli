/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext } from "../types.js"
import { matchGlob, walkFiles } from "../file-edit/fs-walk.js"

const definition: ToolDefinition = {
  name: "code_search",
  description:
    "Search a project directory for an identifier or symbol using word-boundary matching. Returns file paths, line numbers, and the matched line. Prefer this over grep when locating definitions or usages of a function, class, variable, or API name.",
  parameters: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "Identifier or symbol to search for, e.g. 'startServer'." },
      path: { type: "string", description: "Directory to search. Default: project root." },
      glob: { type: "string", description: "Only search files matching this glob (e.g. '*.ts')." },
      ignore_case: { type: "boolean", description: "Case-insensitive match. Default false." },
      max_results: { type: "integer", description: "Maximum matches to return. Default 120." },
    },
  },
}

export function createCodeSearchTool(): Tool {
  return {
    definition,
    async execute(_id, args, _signal, _update, context) {
      const ctx = context as ToolContext
      const query = String(args.query ?? "")
      if (!query) return textResult("Missing 'query'.", true)
      const base = path.resolve(ctx.cwd, typeof args.path === "string" ? args.path : ".")
      const glob = typeof args.glob === "string" ? args.glob : "*"
      const flags = args.ignore_case ? "i" : ""
      const maxResults = typeof args.max_results === "number" ? args.max_results : 120

      let regex: RegExp
      try {
        // Word boundary around the identifier so `read` does not match `thread`.
        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        regex = new RegExp(`\\b${escaped}\\b`, flags)
      } catch {
        return textResult(`Invalid query: ${query}`, true)
      }

      const results: string[] = []
      const perFile: Array<{ file: string; lines: string[] }> = []
      const seen = new Map<string, number>()
      walkFiles(base, (abs, rel) => {
        if (!matchGlob(glob, rel)) return
        if (results.length >= maxResults) return
        let stat: fs.Stats
        try {
          stat = fs.statSync(abs)
        } catch {
          return
        }
        if (stat.size > ctx.config.maxOutputBytes) return // skip huge/binary files
        let content: string
        try {
          content = fs.readFileSync(abs, "utf8")
        } catch {
          return
        }
        if (!/^[\t\n\r\x20-\x7e\xa0-\uffff]*$/.test(content)) return // binary guard
        const lines = content.split("\n")
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxResults) break
          if (regex.test(lines[i])) {
            const key = rel
            const idx = seen.get(key) ?? perFile.length
            if (idx >= perFile.length) perFile.push({ file: rel, lines: [] })
            seen.set(key, idx)
            perFile[idx].lines.push(`${i + 1}: ${lines[i].trim()}`)
            results.push(`${rel}:${i + 1}: ${lines[i].trim()}`)
          }
        }
      })

      if (results.length === 0) return textResult(`No identifiers matched '${query}' in ${base}`)
      const grouped = perFile
        .map((f) => `  ${f.file} (${f.lines.length}):\n${f.lines.map((l) => `    ${l}`).join("\n")}`)
        .join("\n")
      return textResult(`${results.length} match(es) for '${query}':\n${grouped}`)
    },
  }
}
