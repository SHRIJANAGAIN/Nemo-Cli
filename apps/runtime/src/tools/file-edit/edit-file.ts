/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
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
import { findOldStringSpans } from "./fuzzy-match.js"
import { miniDiff } from "../text/diff-render.js"

const definition: ToolDefinition = {
  name: "edit_file",
  description:
    "Edit a file by replacing text. Provide old_string (unique in the file) and new_string. Set replace_all to change every occurrence. Exact matches win; when nothing matches exactly, a whitespace/unicode-tolerant unique match is accepted (indentation drift, trailing spaces, CRLF/LF, smart quotes). Fails if old_string is not found or is not unique (unless replace_all). .git and .trayambak directories are read-only metadata: edits to them are rejected.",
  parameters: {
    type: "object",
    required: ["path", "old_string", "new_string"],
    properties: {
      path: { type: "string", description: "Relative or absolute path to the file." },
      old_string: {
        type: "string",
        description: "Text to replace (whitespace-tolerant fallback when not byte-exact).",
      },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace all occurrences. Default false." },
    },
  },
}

export function createEditFileTool(): Tool {
  return {
    definition,
    async execute(_id, args, signal, _update, context) {
      try {
        if (signal?.aborted) return textResult("aborted", true)
        const ctx = context as ToolContext
        const rawPath = String(args.path ?? "")
        const oldStr = String(args.old_string ?? "")
        const newStr = String(args.new_string ?? "")
        const replaceAll = Boolean(args.replace_all)
        if (!rawPath) return textResult("Missing 'path'.", true)
        if (!oldStr) return textResult("Missing 'old_string'.", true)

        let target: string
        try {
          target = resolveConstrainedPath(rawPath, ctx.cwd)
          assertExternalDirectory(target, ctx.cwd)
          assertMutablePath(target)
        } catch (error) {
          return textResult(`Access denied: ${error instanceof Error ? error.message : String(error)}`, true)
        }

        if (signal?.aborted) return textResult("aborted", true)

        if (ctx.requestPermission) {
          const ok = await ctx.requestPermission("edit_file", rawPath, "Trayambak approval required for edit_file")
          if (!ok) return textResult("Permission denied for edit_file: " + rawPath, true)
        }

        if (signal?.aborted) return textResult("aborted", true)

        if (!fs.existsSync(target)) return textResult(`File not found: ${rawPath}`, true)

        const original = fs.readFileSync(target, "utf8")
        const count = original.split(oldStr).length - 1
        if (count === 0) {
          // No byte-exact hit: progressive fallback (trimEnd → trim →
          // unicode). Applied only when UNIQUE — an ambiguous loose match
          // still errors rather than guessing which span to rewrite.
          const spans = findOldStringSpans(original, oldStr)
          if (spans.length === 0) return textResult(`old_string not found in ${rawPath}`, true)
          if (spans.length > 1) {
            return textResult(
              `old_string is not unique (${spans.length} whitespace-tolerant matches). Make it unique or set replace_all.`,
              true,
            )
          }
          const span = spans[0] as { start: number; end: number; pass: string }
          const updated = original.slice(0, span.start) + newStr + original.slice(span.end)
          fs.writeFileSync(target, updated, "utf8")
          const note = await syntaxNote(target, updated)
          const preview = miniDiff(original.slice(span.start, span.end), newStr).join("\n")
          return textResult(`Edited ${rawPath} (1 occurrence, ${span.pass} match).${note}\n${preview}`)
        }
        if (count > 1 && !replaceAll) {
          return textResult(`old_string is not unique (${count} matches). Make it unique or set replace_all.`, true)
        }
        const updated = replaceAll ? original.split(oldStr).join(newStr) : original.replace(oldStr, newStr)
        fs.writeFileSync(target, updated, "utf8")
        // LSP-lite: surface syntax errors in the edited file immediately
        // (semantic type checking lives in the `diagnostics` tool).
        const note = await syntaxNote(target, updated)
        // Structured final (opencode port): the changed lines ride along so
        // the transcript shows what actually changed, not just a count.
        const preview = miniDiff(oldStr, newStr).join("\n")
        return textResult(`Edited ${rawPath} (${count} occurrence${count > 1 ? "s" : ""}).${note}\n${preview}`)
      } catch (error) {
        return textResult(`Edit error: ${error instanceof Error ? error.message : String(error)}`, true)
      }
    },
  }
}
