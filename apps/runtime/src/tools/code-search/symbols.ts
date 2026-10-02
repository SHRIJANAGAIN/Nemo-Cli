/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext } from "../types.js"
import { matchGlob, walkFiles } from "../file-edit/fs-walk.js"

/**
 * Offline symbol index (legacy semantic-search parity, dependency-free
 * edition): regex definition extractors per language, evaluated at search
 * time over the workspace walk. Heuristic by design — it finds `function`,
 * `class`, and friends without an embeddings service or tree-sitter —
 * so `symbol_search` answers "where is X defined?" while `code_search`
 * answers "where is X mentioned?".
 */

export type SymbolKind = "function" | "class" | "interface" | "method" | "variable" | "type"

/** Longest source line the definition regexes ever examine (ReDoS guard). */
export const MAX_SYMBOL_LINE = 2000

export interface SymbolHit {
  file: string
  line: number
  kind: SymbolKind
  name: string
  signature: string
}

type Lang = "ts" | "py" | "go" | "rust" | "java" | "c"

const EXT_LANG: Record<string, Lang> = {
  ".ts": "ts",
  ".tsx": "ts",
  ".js": "ts",
  ".jsx": "ts",
  ".mjs": "ts",
  ".cjs": "ts",
  ".py": "py",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "c",
  ".hpp": "c",
}

export function languageOf(filename: string): Lang | null {
  return EXT_LANG[path.extname(filename).toLowerCase()] ?? null
}

const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
  "return",
  "new",
  "typeof",
  "else",
  "do",
  "case",
])

interface Pattern {
  kind: SymbolKind
  re: RegExp
  nameIndex: number
}

const PATTERNS: Record<Lang, Pattern[]> = {
  ts: [
    { kind: "function", re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, nameIndex: 1 },
    { kind: "class", re: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, nameIndex: 1 },
    { kind: "interface", re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, nameIndex: 1 },
    { kind: "type", re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/, nameIndex: 1 },
    {
      kind: "function",
      re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
      nameIndex: 1,
    },
    { kind: "method", re: /^\s+(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/, nameIndex: 1 },
  ],
  py: [
    { kind: "function", re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, nameIndex: 1 },
    { kind: "class", re: /^\s*class\s+([A-Za-z_]\w*)/, nameIndex: 1 },
  ],
  go: [
    { kind: "function", re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, nameIndex: 1 },
    { kind: "type", re: /^\s*type\s+([A-Za-z_]\w*)/, nameIndex: 1 },
  ],
  rust: [
    { kind: "function", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?fn\s+([A-Za-z_]\w*)/, nameIndex: 1 },
    { kind: "class", re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/, nameIndex: 1 },
  ],
  java: [
    {
      kind: "class",
      re: /^\s*(?:public|private|protected)?\s*(?:static\s+|final\s+|abstract\s+)?(?:class|interface|enum)\s+(\w+)/,
      nameIndex: 1,
    },
    {
      kind: "method",
      re: /^\s{2,}(?:public|private|protected|static|final|synchronized|native|abstract|\s)*[\w<>\[\]]+\s+(\w+)\s*\(/,
      nameIndex: 1,
    },
  ],
  c: [
    { kind: "class", re: /^\s*(?:class|struct)\s+(\w+)/, nameIndex: 1 },
    { kind: "function", re: /^[\w][\w\s\*&:<>]*?\s+(\w+)\s*\([^;{}]*$/, nameIndex: 1 },
  ],
}

/** Extract definitions from source text. Pure. */
export function extractSymbols(
  content: string,
  lang: Lang,
): Array<{ line: number; kind: SymbolKind; name: string; signature: string }> {
  const out: Array<{ line: number; kind: SymbolKind; name: string; signature: string }> = []
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    // Minified single-line monsters would feed megabytes to the definition
    // regexes (nested quantifiers) — examine a prefix instead of hanging.
    const raw = lines[i]!
    const line = raw.length > MAX_SYMBOL_LINE ? raw.slice(0, MAX_SYMBOL_LINE) : raw
    for (const pattern of PATTERNS[lang]) {
      const match = pattern.re.exec(line)
      if (!match) continue
      const name = match[pattern.nameIndex]!
      if (KEYWORDS.has(name)) continue
      out.push({ line: i + 1, kind: pattern.kind, name, signature: line.trim().slice(0, 120) })
      break
    }
  }
  return out
}

export interface SymbolSearchOptions {
  glob?: string
  maxResults?: number
  ignoreCase?: boolean
}

/** Find definitions of `name` under `root`. Pure apart from fs. */
export function searchSymbols(root: string, name: string, opts: SymbolSearchOptions = {}): SymbolHit[] {
  const glob = opts.glob ?? "*"
  const maxResults = opts.maxResults ?? 60
  const needle = opts.ignoreCase ? name.toLowerCase() : name
  const hits: SymbolHit[] = []
  walkFiles(root, (abs, rel) => {
    if (hits.length >= maxResults) return
    if (!matchGlob(glob, rel)) return
    if (languageOf(rel) === null) return
    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
    } catch {
      return
    }
    if (stat.size > 1024 * 1024) return
    let content: string
    try {
      content = fs.readFileSync(abs, "utf8")
    } catch {
      return
    }
    if (!/^[\t\n\r\x20-\x7e\xa0-\uffff]*$/.test(content)) return
    const lang = languageOf(rel)!
    for (const symbol of extractSymbols(content, lang)) {
      if (hits.length >= maxResults) break
      const candidate = opts.ignoreCase ? symbol.name.toLowerCase() : symbol.name
      if (candidate !== needle) continue
      hits.push({ file: rel, line: symbol.line, kind: symbol.kind, name: symbol.name, signature: symbol.signature })
    }
  })
  return hits
}

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "symbol_search",
  description:
    "Find where a symbol is DEFINED (functions, classes, interfaces, methods, types) across the project. Returns file, line, kind, and signature. Prefer this over code_search when locating definitions; use code_search for usages.",
  parameters: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", description: "Exact symbol name to find definitions for, e.g. 'startServer'." },
      path: { type: "string", description: "Directory to search. Default: project root." },
      glob: { type: "string", description: "Only search files matching this glob (e.g. '*.ts')." },
      ignore_case: { type: "boolean", description: "Case-insensitive match. Default false." },
      max_results: { type: "number", description: "Maximum definitions to return. Default 60." },
    },
  },
}

/** `symbol_search` tool: offline definition lookup. */
export function createSymbolSearchTool(): Tool {
  return {
    definition,
    async execute(_id, args, _signal, _update, context) {
      const ctx = context as ToolContext
      const name = String(args.name ?? "")
      if (!name) return textResult("Missing 'name'.", /*isError*/ true)
      const base = path.resolve(ctx.cwd, typeof args.path === "string" ? args.path : ".")
      const hits = searchSymbols(base, name, {
        glob: typeof args.glob === "string" ? args.glob : undefined,
        maxResults: typeof args.max_results === "number" ? args.max_results : undefined,
        ignoreCase: Boolean(args.ignore_case),
      })
      if (hits.length === 0) return textResult(`No definitions of '${name}' in ${base}`)
      const body = hits.map((h) => `  ${h.file}:${h.line} [${h.kind}] ${h.name} — ${h.signature}`).join("\n")
      return textResult(`${hits.length} definition(s) of '${name}':\n${body}`)
    },
  }
}
