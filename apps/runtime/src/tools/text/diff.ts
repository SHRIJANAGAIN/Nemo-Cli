/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { Tool, ToolResult } from "../types.js"
import { textResult, resolveConstrainedPath } from "../types.js"
import * as fs from "fs"
import * as path from "path"

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
      timeoutMs: 30_000,
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
        else return textResult("Provide either file_b or text_b to diff against.", /*isError*/ true)
        return textResult(
          unifiedDiff(String(args.file_a), String(args.file_b ?? "<text>"), aText.split(/\r?\n/), bText.split(/\r?\n/)),
        )
      } catch (e) {
        return textResult(`diff failed: ${e instanceof Error ? e.message : String(e)}`, /*isError*/ true)
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
      timeoutMs: 30_000,
      name: "patch",
      description:
        "Apply a unified diff patch to one or more files. Provide either 'file' + 'patch' (single file) or 'files' (array of {file, patch}) to apply several patches ATOMICALLY: every patch is validated against the current file contents first, and if any one of them fails, NO file is written. Input is unified diff format with @@ hunks (as produced by the diff tool). Fails safely with a clear error if context mismatches — files are never left partially modified.",
      parameters: {
        type: "object",
        // Either file+patch (single) or files[] (multi) — nothing is
        // unconditionally required; execute() validates the shape at runtime.
        required: [],
        properties: {
          file: { type: "string", description: "Path to the file to patch (single-file mode)." },
          patch: { type: "string", description: "Unified diff patch text (single-file mode)." },
          files: {
            type: "array",
            description:
              "Multi-file mode: several {file, patch} entries applied all-or-nothing. Each item is an object with file (string path) and patch (string unified diff text) — both required.",
            items: {
              type: "object",
              description: "One patch entry: file (path to patch) + patch (unified diff text for this file).",
            },
          },
        },
      },
    },
    async execute(_id, args) {
      const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
      const multiInput = args.files !== undefined
      if (multiInput && args.file !== undefined) {
        return textResult("Provide either 'file' + 'patch' or 'files', not both.", /*isError*/ true)
      }

      // ── Phase 0: parse argument shape (single vs multi) ──
      const jobs: Array<{ file: string; resolved: string; patch: string }> = []
      if (multiInput) {
        if (!Array.isArray(args.files)) {
          return textResult("'files' must be an array of {file, patch} objects.", /*isError*/ true)
        }
        if (args.files.length === 0) {
          return textResult("'files' is empty — provide at least one {file, patch} entry.", /*isError*/ true)
        }
        const seen = new Set<string>()
        for (let i = 0; i < args.files.length; i++) {
          const entry: unknown = args.files[i]
          if (
            typeof entry !== "object" ||
            entry === null ||
            typeof (entry as { file?: unknown }).file !== "string" ||
            typeof (entry as { patch?: unknown }).patch !== "string"
          ) {
            return textResult(`files[${i}] must be an object with string 'file' and 'patch'.`, /*isError*/ true)
          }
          const file = (entry as { file: string }).file
          const patch = (entry as { patch: string }).patch
          let resolved: string
          try {
            resolved = resolveConstrainedPath(file, process.cwd())
          } catch (e) {
            return textResult(`patch failed for ${file}: ${errText(e)}`, /*isError*/ true)
          }
          const dupKey = path.normalize(resolved).toLowerCase()
          if (seen.has(dupKey)) {
            return textResult(`Duplicate file in 'files': ${file} — each file may appear only once.`, /*isError*/ true)
          }
          seen.add(dupKey)
          jobs.push({ file, resolved, patch })
        }
      } else {
        if (args.file === undefined || args.patch === undefined) {
          return textResult(
            "Missing arguments: provide 'file' + 'patch', or 'files' (array of {file, patch}).",
            /*isError*/ true,
          )
        }
        let resolved: string
        try {
          resolved = resolveConstrainedPath(String(args.file), process.cwd())
        } catch (e) {
          return textResult(`patch failed: ${errText(e)}`, /*isError*/ true)
        }
        jobs.push({ file: String(args.file), resolved, patch: String(args.patch) })
      }
      const multi = multiInput
      const failFor = (file: string, e: unknown): ToolResult =>
        textResult(multi ? `patch failed for ${file}: ${errText(e)}` : `patch failed: ${errText(e)}`, /*isError*/ true)

      // ── Phase 1: validate + compute EVERY target in memory. Any failure
      //    here aborts before a single byte is written (all-or-nothing). ──
      const computed: Array<{
        job: (typeof jobs)[number]
        oldContent: string
        newContent: string
        changed: boolean
      }> = []
      for (const job of jobs) {
        let oldContent: string
        try {
          oldContent = fs.readFileSync(job.resolved, "utf8")
        } catch (e) {
          return failFor(job.file, e)
        }
        let newContent: string
        try {
          newContent = applyUnifiedPatch(oldContent, job.patch)
        } catch (e) {
          return failFor(job.file, e)
        }
        computed.push({ job, oldContent, newContent, changed: newContent !== oldContent })
      }

      // ── Phase 2: write. If a write fails mid-batch, restore every file
      //    already written from the in-memory originals (rollback). ──
      const written: Array<{ resolved: string; oldContent: string }> = []
      for (const c of computed) {
        if (!c.changed) continue
        try {
          fs.writeFileSync(c.job.resolved, c.newContent, "utf8")
        } catch (e) {
          let restored = 0
          for (let i = written.length - 1; i >= 0; i--) {
            try {
              fs.writeFileSync(written[i].resolved, written[i].oldContent, "utf8")
              restored++
            } catch {
              /* best-effort rollback */
            }
          }
          const rollback =
            written.length === 0
              ? ""
              : restored > 0
                ? `; rolled back ${restored} earlier write(s)`
                : "; rollback of earlier writes failed"
          if (multi) {
            return textResult(`patch failed for ${c.job.file} (write): ${errText(e)}${rollback}`, /*isError*/ true)
          }
          return textResult(`patch failed: ${errText(e)}`, /*isError*/ true)
        }
        written.push({ resolved: c.job.resolved, oldContent: c.oldContent })
      }

      const anyChanged = computed.some((c) => c.changed)
      if (!anyChanged) return textResult("Patch applied cleanly but produced no changes.")
      if (!multi) {
        const c = computed[0]
        return textResult(
          `Patched ${c.job.file}: ${c.oldContent.split("\n").length} -> ${c.newContent.split("\n").length} lines`,
        )
      }
      const changedCount = computed.filter((c) => c.changed).length
      const perFile = computed
        .map((c) =>
          c.changed
            ? `  ${c.job.file}: ${c.oldContent.split("\n").length} -> ${c.newContent.split("\n").length} lines`
            : `  ${c.job.file}: no changes`,
        )
        .join("\n")
      return textResult(`Patched ${changedCount} of ${computed.length} file(s):\n${perFile}`)
    },
  }
}
