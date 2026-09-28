/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * LSP-lite diagnostics core — ports SKT AI LABS's lsp/diagnostic.ts + tool/diagnostics.ts
 * (pretty/report/filterDiagnostics, verbatim) on top of tsc output instead of a
 * live language server: trayambak has no LSP dependency, while TypeScript's
 * compiler ships with every working install (the shim's build requires it).
 *
 * Diagnostics carry the LSP Diagnostic shape (0-based range), so a real LSP
 * backend can be swapped in later without touching consumers.
 */

import * as fs from "fs"
import * as path from "path"

/** LSP-shaped diagnostic (0-based range), SKT AI LABS's LSPClient.Diagnostic subset. */
export interface Diagnostic {
  range: { start: { line: number; character: number } }
  /** LSP severity: 1 error, 2 warning, 3 info, 4 hint. */
  severity?: 1 | 2 | 3 | 4
  message: string
  code?: string
  source?: string
}

const SEVERITY_LABEL: Record<number, string> = { 1: "ERROR", 2: "WARN", 3: "INFO", 4: "HINT" }

/** Per-file cap for report blocks (SKT AI LABS: 20). */
export const DIAGNOSTICS_MAX_PER_FILE = 20

/** Skip in-process syntax checks on very large files (transpile cost). */
const MAX_SYNTAX_CHECK_BYTES = 1_000_000

/** SKT AI LABS lsp/diagnostic.ts pretty(): `ERROR [12:5] message`, 1-based position. */
export function pretty(diagnostic: Diagnostic): string {
  const severity = SEVERITY_LABEL[diagnostic.severity || 1] ?? "ERROR"
  const line = diagnostic.range.start.line + 1
  const col = diagnostic.range.start.character + 1
  return `${severity} [${line}:${col}] ${diagnostic.message}`
}

/** SKT AI LABS lsp/diagnostic.ts report(): ERROR-only `<diagnostics>` block, capped
 * per file, `""` when the file has no errors. */
export function report(file: string, issues: Diagnostic[]): string {
  const errors = issues.filter((item) => item.severity === 1)
  if (errors.length === 0) return ""
  const limited = errors.slice(0, DIAGNOSTICS_MAX_PER_FILE)
  const more = errors.length - DIAGNOSTICS_MAX_PER_FILE
  const suffix = more > 0 ? `\n... and ${more} more` : ""
  return `<diagnostics file="${file}">\n${limited.map(pretty).join("\n")}${suffix}\n</diagnostics>`
}

/** SKT AI LABS tool/diagnostics.ts filterDiagnostics verbatim: keep only entries for
 * the requested files (edits receive diagnostics for ALL files; storing or
 * printing them all bloats payloads). */
export function filterDiagnostics(
  diagnostics: Record<string, Diagnostic[]>,
  files: string[],
): Record<string, Diagnostic[]> {
  const result: Record<string, Diagnostic[]> = {}
  for (const file of files) {
    const items = diagnostics[file]
    if (items) result[file] = items
  }
  return result
}

/** Grouping/comparison key: resolved absolute path, case-folded on Windows
 * (tsc and user filters mix separators and casing). */
export function diagnosticsPathKey(p: string, cwd: string): string {
  const resolved = path.resolve(cwd, p)
  return process.platform === "win32" ? resolved.replace(/\//g, "\\").toLowerCase() : resolved
}

/** Resolve user-supplied path filters (relative or absolute) against the
 * record's keys. Empty filter = everything. */
export function pickFiles(
  diagnostics: Record<string, Diagnostic[]>,
  filters: string[],
  cwd: string,
): Record<string, Diagnostic[]> {
  if (filters.length === 0) return diagnostics
  const wanted = new Set(filters.map((f) => diagnosticsPathKey(f, cwd)))
  const result: Record<string, Diagnostic[]> = {}
  for (const [file, items] of Object.entries(diagnostics)) {
    if (wanted.has(diagnosticsPathKey(file, cwd))) result[file] = items
  }
  return result
}

/** `path(line,col): error TS1234: message` (tsc --pretty false). */
const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning|message|info)\s+(TS\d+):\s*(.*)$/i
/** File-less project-level output: `error TS6053: File 'x' not found.` */
const TSC_GLOBAL = /^(error|warning|message|info)\s+(TS\d+):\s*(.*)$/i
const KIND_SEVERITY: Record<string, 1 | 2 | 3 | 4> = { error: 1, warning: 2, info: 3, message: 4 }

/** Parse `tsc --noEmit --pretty false` stdout into an LSP-shaped per-file
 * record (0-based ranges), plus file-less project-level lines. */
export function parseTscOutput(
  output: string,
  cwd: string,
): { diagnostics: Record<string, Diagnostic[]>; unlocated: string[] } {
  const diagnostics: Record<string, Diagnostic[]> = {}
  const unlocated: string[] = []
  const keyByNorm = new Map<string, string>()
  let lastList: Diagnostic[] | undefined
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === "") {
      lastList = undefined
      continue
    }
    const match = TSC_LINE.exec(line)
    if (match) {
      const [, file, ln, col, kind, code, msg] = match
      const display = path.isAbsolute(file) ? path.normalize(file) : path.resolve(cwd, file)
      const norm = diagnosticsPathKey(display, cwd)
      const key = keyByNorm.get(norm) ?? display
      keyByNorm.set(norm, key)
      const list = (diagnostics[key] ??= [])
      list.push({
        range: { start: { line: Number(ln) - 1, character: Number(col) - 1 } },
        severity: KIND_SEVERITY[kind.toLowerCase()] ?? 1,
        message: `${code.toUpperCase()}: ${msg}`,
        code: code.toUpperCase(),
        source: "tsc",
      })
      lastList = list
      continue
    }
    const global = TSC_GLOBAL.exec(line)
    if (global) {
      unlocated.push(line.trim())
      lastList = undefined
      continue
    }
    // Wrapped continuation of the previous message (indented remainder).
    if (lastList?.length && /^\s/.test(line)) {
      const prev = lastList[lastList.length - 1]
      prev.message += ` ${line.trim()}`
    }
  }
  return { diagnostics, unlocated }
}

const CHECKABLE = /\.(tsx?|mts|cts|jsx)$/i

/** Files a lightweight in-process syntax check can handle (.ts/.tsx/.mts/.cts/
 * .jsx — plain .js is excluded: the TS parser rejects JSX in `.js`, which
 * would produce false positives). */
export function isCheckableFile(filePath: string): boolean {
  return CHECKABLE.test(filePath)
}

/** Fast in-process SYNTAX check via typescript's transpileModule (lazy-loaded
 * so the compiler's weight only lands on the first edit/write). Semantic
 * type checking stays with the spawned `diagnostics` tool. */
export async function syntaxDiagnostics(source: string, fileName: string): Promise<Diagnostic[]> {
  if (!isCheckableFile(fileName)) return []
  if (Buffer.byteLength(source, "utf8") > MAX_SYNTAX_CHECK_BYTES) return []
  const ts = await import("typescript")
  const jsx = /\.(tsx|jsx)$/i.test(fileName)
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: jsx ? ts.JsxEmit.React : ts.JsxEmit.Preserve,
    },
  })
  const found = result.diagnostics ?? []
  return found.map((d) => {
    let line = 0
    let character = 0
    if (d.file && d.start !== undefined) {
      const pos = d.file.getLineAndCharacterOfPosition(d.start)
      line = pos.line
      character = pos.character
    }
    const message = ts.flattenDiagnosticMessageText(d.messageText, " ")
    return {
      range: { start: { line, character } },
      severity: d.category === ts.DiagnosticCategory.Error ? 1 : d.category === ts.DiagnosticCategory.Warning ? 2 : 3,
      message,
      source: "typescript",
    } satisfies Diagnostic
  })
}

/** Hook for edit_file/write_file: `""` when the file is clean or not a
 * checkable type, otherwise a leading newline + the SKT AI LABS `<diagnostics>`
 * block so syntax errors surface in the transcript immediately. Never throws. */
export async function syntaxNote(filePath: string, content: string): Promise<string> {
  try {
    const diagnostics = await syntaxDiagnostics(content, filePath)
    if (diagnostics.length === 0) return ""
    const block = report(filePath, diagnostics)
    return block ? `\n${block}` : ""
  } catch {
    return ""
  }
}

/** Walk up from `from` for `fileName` (project-root discovery). */
export function findUp(fileName: string, from: string): string | undefined {
  let dir = path.resolve(from)
  for (;;) {
    const candidate = path.join(dir, fileName)
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* unreadable dir — keep walking */
    }
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}
