/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext, resolveConstrainedPath, assertExternalDirectory } from "../types.js"
import { PathChangedError, identityOf, openVerified, readVerifiedPrefix, type VerifiedHandle } from "./verified-read.js"
import { noteOpen } from "../../../../../packages/core/src/frecency.js"
import { binaryReadMessage, detectBinaryFd } from "../text/binary-detect.js"

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
/**
 * Probe the binary format off the SAME verified descriptor the read will use.
 *
 * Probing by path opened the file a second time, so the bytes that decided
 * "binary / text" could be different from the bytes then read — a TOCTOU window
 * reopened right after #121 closed it. One open, one identity check, one set of
 * bytes. Returns null when the file is fine to read as text.
 */
function binaryRefusal(handle: VerifiedHandle, size: number, label: string): string | null {
  const info = detectBinaryFd(handle.fd, size)
  // A recognised format is refused at any size — we know exactly what it is. An
  // unrecognised NUL-heavy file is usually a sparse hole or a truncated write,
  // and #75 guarantees those still yield a bounded prefix plus an explicit
  // truncation notice, which is already actionable.
  const recognised = info.format !== undefined && info.format !== "utf16"
  if (!recognised && size > MAX_BYTES) return null
  return binaryReadMessage(info, label)
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
        // One descriptor for the whole operation: probe AND read. Decoding a
        // binary file as UTF-8 does not throw — it returns U+FFFD per invalid
        // byte — so a .docx/.pdf used to come back as a screenful of `�` that
        // looks like content. Refuse with the format named instead.
        const handle = openVerified(target, expected)
        try {
          const refusal = binaryRefusal(handle, stat.size, target)
          if (refusal) return textResult(refusal, /*isError*/ true)
          raw = readVerifiedPrefix(handle.fd, handle.identity, truncated ? MAX_BYTES : Math.max(1, stat.size))
        } catch (error) {
          if (error instanceof PathChangedError) return textResult(error.message, /*isError*/ true)
          throw error
        } finally {
          fs.closeSync(handle.fd)
        }

        // A read is a genuine "open" for frecency ranking. Fire-and-forget after
        // the read SUCCEEDS: a denied or failed read is not a file the user is
        // working in, and noteOpen can never throw.
        noteOpen(target)

        // A trailing newline is a TERMINATOR, not an empty final line, but
        // `split("\n")` turns "a\nb\n" into ["a","b",""] — a phantom line that
        // invents both a numbered row and a line count the file does not have
        // (wc -l says 2, the reply said 3 and printed "3 | "). Strip the
        // terminator before splitting; a genuinely blank file or a real blank
        // last line survives this.
        const lineSource = raw.endsWith("\n") ? raw.slice(0, -1) : raw
        const lines = lineSource.length === 0 ? [] : lineSource.split("\n")
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
