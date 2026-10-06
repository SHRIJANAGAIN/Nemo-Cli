/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext, resolveConstrainedPath, assertExternalDirectory } from "../types.js"
import { PathChangedError, identityOf, openVerified, readVerifiedPrefix } from "./verified-read.js"
import { noteOpen } from "../../../../../packages/core/src/frecency.js"

const MAX_BYTES = 50 * 1024
const MAX_LINES = 500

/**
 * Read at most `maxBytes` from an open descriptor.
 *
 * `readFileSync(path, "utf8")` cannot be bounded — it allocates the whole
 * file and only the caller's `.slice()` limits the reply. Reading through a
 * descriptor with an explicit length caps the allocation itself, which is the
 * difference between a 50 KB reply and an out-of-memory kill when the model
 * points this tool at a 4 GB log.
 *
 * #121: the descriptor is opened ONCE and every byte comes from it, so a file
 * renamed over the approved path between validation and open cannot be read
 * in its place. See `./verified-read.ts`.
 */
function readPrefix(target: string, maxBytes: number, expected: ReturnType<typeof identityOf>): string {
  const handle = openVerified(target, expected)
  try {
    return readVerifiedPrefix(handle.fd, handle.identity, maxBytes)
  } finally {
    fs.closeSync(handle.fd)
  }
}

const definition: ToolDefinition = {
  timeoutMs: 30_000,
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
        if (signal?.aborted) return textResult("aborted", /*isError*/ true)
        const ctx = context as ToolContext
        const rawPath = String(args.path ?? "")
        if (!rawPath) return textResult("Missing 'path'.", /*isError*/ true)

        let target: string
        try {
          target = resolveConstrainedPath(rawPath, ctx.cwd)
        } catch (error) {
          return textResult(
            `Access denied: ${error instanceof Error ? error.message : String(error)}`,
            /*isError*/ true,
          )
        }

        if (signal?.aborted) return textResult("aborted", /*isError*/ true)
        assertExternalDirectory(target, ctx.cwd)

        if (!fs.existsSync(target)) return textResult(`File not found: ${rawPath}`, /*isError*/ true)
        if (signal?.aborted) return textResult("aborted", /*isError*/ true)
        const stat = fs.statSync(target)
        if (!stat.isFile()) return textResult(`Not a file: ${rawPath}`, /*isError*/ true)

        const offset = typeof args.offset === "number" && Number.isInteger(args.offset) ? Math.max(1, args.offset) : 1
        let limit = typeof args.limit === "number" && Number.isInteger(args.limit) ? Math.max(1, args.limit) : 2000
        if (limit > MAX_LINES) limit = MAX_LINES

        // Size first, then read at most MAX_BYTES — the cap now bounds the
        // allocation, not just the reply. The identity is captured HERE, at
        // validation time, and the read below refuses anything that is no
        // longer the same file (#121).
        const expected = identityOf(stat)
        const truncated = stat.size > MAX_BYTES
        let raw: string
        try {
          raw = readPrefix(target, truncated ? MAX_BYTES : Math.max(1, stat.size), expected)
        } catch (error) {
          if (error instanceof PathChangedError) return textResult(error.message, /*isError*/ true)
          throw error
        }

        // A read is a genuine "open" for frecency ranking. Fire-and-forget after
        // the read SUCCEEDS: a denied or failed read is not a file the user is
        // working in, and noteOpen can never throw.
        noteOpen(target)

        const lines = raw.split("\n")
        const slice = lines.slice(offset - 1, offset - 1 + limit)
        const numbered = slice.map((line, i) => `${String(offset + i).padStart(5)} | ${line}`).join("\n")
        // A byte-truncated prefix has no knowable total, so only the
        // offset/limit slice may claim a "more lines" count.
        const more =
          !truncated && lines.length > offset - 1 + limit
            ? `\n... (${lines.length - (offset - 1 + limit)} more lines)`
            : ""
        const capped = truncated ? `\n[content capped to ${MAX_BYTES / 1024} KB of ${stat.size} bytes]` : ""

        return textResult(
          `File: ${rawPath} (${truncated ? `${lines.length} lines read, file truncated` : `${lines.length} lines`})\n${numbered}${more}${capped}`,
        )
      } catch (error) {
        return textResult(`Read error: ${error instanceof Error ? error.message : String(error)}`, /*isError*/ true)
      }
    },
  }
}
