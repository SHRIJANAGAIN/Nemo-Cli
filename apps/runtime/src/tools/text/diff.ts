/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { Tool } from "../types.js"
import { textResult, resolveConstrainedPath } from "../types.js"
import * as fs from "fs"

/** Classic LCS-based line diff producing unified-format hunks. */
export function diffLines(a: string[], b: string[]): Array<{ op: " " | "-" | "+"; line: string }> {
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const out: Array<{ op: " " | "-" | "+"; line: string }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: " ", line: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: "-", line: a[i] })
      i++
    } else {
      out.push({ op: "+", line: b[j] })
      j++
    }
  }
  while (i < n) {
    out.push({ op: "-", line: a[i++] })
  }
  while (j < m) {
    out.push({ op: "+", line: b[j++] })
  }
  return out
}

export function unifiedDiff(fileA: string, fileB: string, a: string[], b: string[], context = 3): string {
  const ops = diffLines(a, b)
  if (!ops.some((o) => o.op !== " ")) return "(no differences)"
  const lines: string[] = [`--- ${fileA}`, `+++ ${fileB}`]
  let k = 0
  while (k < ops.length) {
    if (ops[k].op === " ") {
      k++
      continue
    }
    // find hunk start: walk back over context lines
    let start = k
    let ctx = 0
    while (start > 0 && ctx < context) {
      start--
      if (ops[start].op === " ") {
        ctx++
      } else {
        ctx = 0
      }
    }
    // find hunk end: walk forward over changes + trailing context
    let end = k
    ctx = 0
    while (end < ops.length) {
      if (ops[end].op === " ") {
        ctx++
        if (ctx >= context) break
      } else ctx = 0
      end++
    }
    const hunk = ops.slice(start, Math.min(ops.length, end))
    const aStart = hunk.filter((o) => o.op !== "+").length
    const bStart = hunk.filter((o) => o.op !== "-").length
    lines.push(`@@ -${Math.max(1, start + 1)},${aStart} +${Math.max(1, start + 1)},${bStart} @@`)
    for (const h of hunk) lines.push(h.op + h.line)
    k = end + 1
  }
  return lines.join("\n")
}

export function createDiffTool(): Tool {
  return {
    definition: {
      name: "diff",
      description:
        "Generate a unified diff between two files (or a file and inline text). Use this to show exactly what changed between two versions.",
      parameters: {
        type: "object",
        properties: {
          file_a: { type: "string", description: "Path to the original file" },
          file_b: { type: "string", description: "Path to the modified file" },
          text_b: { type: "string", description: "Alternative: inline text to diff against file_a" },
        },
        required: ["file_a"],
      },
    },
    async execute(_id, args) {
      try {
        const pa = resolveConstrainedPath(String(args.file_a), process.cwd())
        const aText = fs.readFileSync(pa, "utf8")
        let bText: string
        if (typeof args.text_b === "string") bText = args.text_b
        else if (typeof args.file_b === "string")
          bText = fs.readFileSync(resolveConstrainedPath(String(args.file_b), process.cwd()), "utf8")
        else return textResult("Provide either file_b or text_b to diff against.", true)
        return textResult(
          unifiedDiff(String(args.file_a), String(args.file_b ?? "<text>"), aText.split(/\r?\n/), bText.split(/\r?\n/)),
        )
      } catch (e) {
        return textResult(`diff failed: ${e instanceof Error ? e.message : String(e)}`, true)
      }
    },
  }
}

/**
 * Apply a unified diff (as produced by the `diff` tool) to file content.
 * Parses @@ hunks and applies context-aware line operations. Safe: it
 * builds a fresh result and only writes when every hunk matches.
 */
export function applyUnifiedPatch(content: string, patch: string): string {
  const result = content.split(/\r?\n/)
  const patchLines = patch.split(/\r?\n/).filter((l) => !l.startsWith("index ") && !l.startsWith("diff "))
  const hunks: Array<{ aStart: number; ops: Array<{ op: string; text: string }> }> = []
  let cur: { aStart: number; ops: Array<{ op: string; text: string }> } | null = null
  for (const l of patchLines) {
    const m = /^@@\s*-(\d+)(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@/.exec(l)
    if (m) {
      cur = { aStart: parseInt(m[1], 10) - 1, ops: [] }
      hunks.push(cur)
      continue
    }
    if (cur && /^[ +-]/.test(l) && l.length > 1 && l[0] !== "\\") {
      cur.ops.push({ op: l[0], text: l.slice(1) })
    }
  }
  if (hunks.length === 0) {
    // no @@ headers → treat as full-file replacement if a ---/+++ pair present
    const body = patch.split(/\r?\n/).filter((l) => !/^(---|\+\+\+|diff |index )/.test(l))
    if (body.every((l) => /^[ +-]/.test(l))) {
      return body
        .filter((l) => l[0] !== "-")
        .map((l) => l.slice(1))
        .join("\n")
    }
    throw new Error("no @@ hunks found in patch")
  }
  const working = [...result]
  for (const hunk of [...hunks].reverse()) {
    let pos = hunk.aStart
    for (const { op, text } of hunk.ops) {
      if (op === " ") {
        if ((working[pos] ?? "") !== text) {
          throw new Error(
            `patch context mismatch at line ${pos + 1}: expected "${text}", found "${working[pos] ?? "<eof>"}"`,
          )
        }
        pos++
      } else if (op === "-") {
        if ((working[pos] ?? "") !== text) {
          throw new Error(
            `patch context mismatch at line ${pos + 1}: expected "${text}", found "${working[pos] ?? "<eof>"}"`,
          )
        }
        working.splice(pos, 1)
      } else if (op === "+") {
        working.splice(pos, 0, text)
        pos++
      }
    }
  }
  return working.join("\n")
}

export function createPatchTool(): Tool {
  return {
    definition: {
      name: "patch",
      description:
        "Apply a unified diff patch to a file. Input is unified diff format with @@ hunks (as produced by the diff tool). Fails safely with a clear error if context mismatches — the file is never left partially modified.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "Path to the file to patch" },
          patch: { type: "string", description: "Unified diff patch text" },
        },
        required: ["file", "patch"],
      },
    },
    async execute(_id, args) {
      try {
        const p = resolveConstrainedPath(String(args.file), process.cwd())
        const content = fs.readFileSync(p, "utf8")
        const patchStr = applyUnifiedPatch(content, String(args.patch))
        if (patchStr === content) return textResult("Patch applied cleanly but produced no changes.")
        fs.writeFileSync(p, patchStr, "utf8")
        return textResult(`Patched ${args.file}: ${content.split("\n").length} -> ${patchStr.split("\n").length} lines`)
      } catch (e) {
        return textResult(`patch failed: ${e instanceof Error ? e.message : String(e)}`, true)
      }
    },
  }
}
