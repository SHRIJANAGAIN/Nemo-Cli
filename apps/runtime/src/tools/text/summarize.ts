/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { Tool } from "../types.js"
import { textResult, resolveConstrainedPath } from "../types.js"
import { MAX_TEXT_FILE_BYTES, readFileTextCapped } from "./capped-read.js"

/** Lightweight extractive summarizer: scores sentences by word frequency. */
export function summarizeText(text: string, maxWords = 60): string {
  const cleaned = text.replace(/\s+/g, " ").trim()
  if (cleaned.length <= maxWords * 8) return cleaned
  const sentences = cleaned.split(/(?<=[.!?])\s+/)
  const freq = new Map<string, number>()
  for (const w of cleaned
    .toLowerCase()
    .split(/[^\w'-]+/)
    .filter((s) => s.length > 2)) {
    freq.set(w, (freq.get(w) ?? 0) + 1)
  }
  const scored = sentences.map((s, i) => {
    const words = s
      .toLowerCase()
      .split(/[^\w'-]+/)
      .filter((t) => t.length > 2)
    let score = 0
    for (const w of words) score += freq.get(w) ?? 0
    return { s, score: score / Math.max(1, words.length), i }
  })
  // keep first few always, then top-scoring remainder in original order
  const keepFirst = Math.min(2, sentences.length)
  const rest = scored
    .slice(keepFirst)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(2, Math.round(maxWords / 12)))
  const selected = [...scored.slice(0, keepFirst), ...rest].sort((a, b) => a.i - b.i)
  void freq
  void cleaned
  return selected.map((x) => x.s).join(" ")
}

export function createSummarizeTool(): Tool {
  return {
    definition: {
      timeoutMs: 30_000,
      name: "summarize",
      description:
        "Generate an extractive summary of a text file, commit message, README, or long output. Use this when you need the essence of a long document without reading it fully.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "Path to the file to summarize" },
          text: { type: "string", description: "Inline text to summarize instead of a file" },
          max_words: { type: "number", description: "Approximate target summary length in words" },
        },
        required: [],
      },
    },
    async execute(_id, args) {
      try {
        let text: string
        let truncated = false
        let totalBytes = 0
        if (typeof args.text === "string") text = args.text
        else if (typeof args.file === "string") {
          const p = resolveConstrainedPath(String(args.file), process.cwd())
          const capped = readFileTextCapped(p)
          text = capped.text
          truncated = capped.truncated
          totalBytes = capped.totalBytes
        } else return textResult("Provide either a file or inline text.", /*isError*/ true)
        const maxWords = typeof args.max_words === "number" ? Number(args.max_words) : 60
        const summary = summarizeText(text, maxWords)
        return textResult(
          truncated
            ? `${summary}\n\n[source truncated at ${MAX_TEXT_FILE_BYTES} bytes of ${totalBytes} — the summary covers only the prefix]`
            : summary,
        )
      } catch (e) {
        return textResult(`summarize failed: ${e instanceof Error ? e.message : String(e)}`, /*isError*/ true)
      }
    },
  }
}

export function createExtractTool(): Tool {
  return {
    definition: {
      timeoutMs: 30_000,
      name: "extract",
      description:
        "Extract a matching content block from a file — by heading, by a regex pattern, or by line range. Useful for pulling out one function, section, or config block.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "Path to the file" },
          pattern: { type: "string", description: "Regex pattern whose match(es) to return" },
          heading: {
            type: "string",
            description: "H1/H2/H3 heading to start extraction from (until next same-level heading)",
          },
          lines: {
            type: "array",
            description: "[start, end] 1-based line range",
            items: { type: "integer", description: "line number" },
          },
        },
        required: ["file"],
      },
    },
    async execute(_id, args) {
      try {
        const p = resolveConstrainedPath(String(args.file), process.cwd())
        const capped = readFileTextCapped(p)
        const text = capped.text
        const note = capped.truncated
          ? `\n\n[searched only the first ${MAX_TEXT_FILE_BYTES} bytes of ${capped.totalBytes} — file truncated]`
          : ""
        const lines = text.split(/\r?\n/)
        if (Array.isArray(args.lines)) {
          // `Array.isArray` is true for `[]`, and destructuring `[]` or `["5"]`
          // yields undefined bounds. `Math.max(0, undefined - 1)` is NaN and
          // `slice(NaN, NaN)` is `[]`, so the model asked for a line range and got
          // an empty reply with NO error — the worst shape of failure, because
          // there is nothing to react to and it reads as "this file has no such
          // lines" rather than "your argument was malformed".
          const range = args.lines as unknown[]
          if (range.length !== 2 || !range.every((n) => typeof n === "number" && Number.isFinite(n))) {
            return textResult(
              `Invalid 'lines': expected exactly two numbers [start, end], got ${JSON.stringify(args.lines)}.`,
              /*isError*/ true,
            )
          }
          const s = range[0] as number
          const e = range[1] as number
          if (s > e) {
            return textResult(`Invalid 'lines': start ${s} is after end ${e}.`, /*isError*/ true)
          }
          return textResult(lines.slice(Math.max(0, s - 1), Math.min(lines.length, e)).join("\n") + note)
        }
        if (typeof args.heading === "string") {
          const re = new RegExp(`^#{1,3}\\s+${args.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i")
          let start = -1
          for (let i = 0; i < lines.length; i++)
            if (re.test(lines[i])) {
              start = i
              break
            }
          if (start < 0) return textResult("Heading not found." + note, /*isError*/ true)
          let end = lines.length
          for (let i = start + 1; i < lines.length; i++) {
            if (/^#{1,3}\s+/.test(lines[i])) {
              end = i
              break
            }
          }
          return textResult(lines.slice(start, end).join("\n") + note)
        }
        if (typeof args.pattern === "string") {
          const re = new RegExp(args.pattern, "gmi")
          const hits: string[] = []
          let m: RegExpExecArray | null
          while ((m = re.exec(text)) && hits.length < 200) {
            hits.push(m[0].trim().slice(0, 3000))
          }
          return textResult((hits.length ? hits.join("\n---\n") : "(no matches)") + note)
        }
        return textResult("Provide lines, heading, or pattern.", /*isError*/ true)
      } catch (e) {
        return textResult(`extract failed: ${e instanceof Error ? e.message : String(e)}`, /*isError*/ true)
      }
    },
  }
}
