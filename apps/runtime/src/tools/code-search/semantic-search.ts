/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { resolveConstrainedPath, textResult, type Tool, type ToolContext } from "../types.js"
import { matchGlob, walkFiles } from "../file-edit/fs-walk.js"
import { resolveSearchRoot } from "../search/search-root.js"

export interface SemanticDoc {
  path: string
  content: string
}

export interface ScoredDoc {
  path: string
  score: number
  preview: string
}

interface IndexedDoc {
  path: string
  preview: string
  terms: Record<string, number>
  length: number
}

export interface SemanticIndex {
  totalDocs: number
  docFreq: Record<string, number>
  docs: IndexedDoc[]
}

const MAX_FILES = 1000
const MAX_FILE_BYTES = 200 * 1024
const MAX_OUTPUT_CHARS = 8000

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "have",
  "were",
  "are",
  "was",
  "will",
  "would",
  "there",
  "their",
  "about",
  "into",
  "over",
  "after",
  "before",
  "between",
  "under",
  "while",
  "where",
  "which",
  "when",
  "what",
  "then",
  "than",
  "them",
  "they",
  "been",
])

/** Lowercase alphanumeric tokens (len>=2), stopwords removed. Deterministic. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []).filter((t) => !STOPWORDS.has(t))
}

/** Build an in-memory TF-IDF index over file paths + contents. Pure. */
export function buildSemanticIndex(docs: SemanticDoc[]): SemanticIndex {
  const indexed: IndexedDoc[] = []
  const docFreq: Record<string, number> = {}
  for (const doc of docs.slice(0, MAX_FILES)) {
    const tokens = tokenize(`${doc.path.replace(/[\\/]/g, " ")} ${doc.content ?? ""}`)
    if (tokens.length === 0) continue
    const terms: Record<string, number> = {}
    for (const t of tokens) terms[t] = (terms[t] ?? 0) + 1
    for (const t of new Set(tokens)) docFreq[t] = (docFreq[t] ?? 0) + 1
    indexed.push({ path: doc.path, preview: (doc.content ?? "").slice(0, 500), terms, length: tokens.length })
  }
  return { totalDocs: indexed.length, docFreq, docs: indexed }
}

function idf(totalDocs: number, docFreq: number): number {
  return Math.log((totalDocs + 1) / (docFreq + 1)) + 1
}

/** Rank docs for a query string. Ties break by path for determinism. */
export function searchSemanticIndex(index: SemanticIndex, query: string, topK = 10): ScoredDoc[] {
  const queryTerms = tokenize(query)
  if (queryTerms.length === 0 || index.docs.length === 0) return []
  const capped = Math.max(1, Math.min(50, Math.floor(topK)))
  const scored: ScoredDoc[] = []
  for (const doc of index.docs) {
    let score = 0
    for (const t of new Set(queryTerms)) {
      const tf = (doc.terms[t] ?? 0) / doc.length
      if (tf > 0) score += tf * idf(index.totalDocs, index.docFreq[t] ?? 0)
    }
    // Path basename matches are strong intent signals (e.g. query "memory"
    // should surface memory.ts even when its body barely repeats the word).
    const base = doc.path.toLowerCase().split(/[\\/]/).pop() ?? ""
    for (const t of new Set(queryTerms)) {
      if (base.includes(t)) score += 0.5
    }
    if (score > 0) scored.push({ path: doc.path, score, preview: doc.preview })
  }
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.path.localeCompare(b.path)))
  return scored.slice(0, capped)
}

export function formatSemanticResults(query: string, hits: ScoredDoc[]): string {
  if (hits.length === 0) return `No semantically similar files for '${query}'.`
  const body = hits.map((h, i) => `${i + 1}. ${h.path} (score ${h.score.toFixed(3)})`).join("\n")
  const text = `${hits.length} file(s) similar to '${query}':\n${body}`
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)` : text
}

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "semantic_search",
  description:
    "Local semantic file search: ranks project files by TF-IDF similarity to a natural-language query. No network, no embeddings service; deterministic tie-break by path. Prefer code_search for exact identifiers.",
  parameters: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "Natural-language query, e.g. 'session resume checkpoints'." },
      path: { type: "string", description: "Directory to search. Default: project root." },
      glob: { type: "string", description: "Only search files matching this glob (e.g. '*.ts')." },
      top_k: { type: "number", description: "Maximum files to return. Default 10, max 50." },
    },
  },
}

/** Local-only semantic search over the workspace. Builds a per-call in-memory index (no stale cache). */
export function createSemanticSearchTool(): Tool {
  return {
    definition,
    async execute(_id, args, _signal, _update, context) {
      const ctx = context as ToolContext | undefined
      const query = String(args.query ?? "").trim()
      if (!query) return textResult("Missing 'query'.", /*isError*/ true)
      const cwd = ctx?.cwd ?? process.cwd()
      const rawBase = typeof args.path === "string" ? args.path : "."
      let base: string
      try {
        base = resolveConstrainedPath(path.resolve(cwd, rawBase), cwd)
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error), /*isError*/ true)
      }
      const glob = typeof args.glob === "string" ? args.glob : "*"
      const topK = typeof args.top_k === "number" && Number.isFinite(args.top_k) ? args.top_k : 10
      const docs: SemanticDoc[] = []
      try {
        const scan = (abs: string, rel: string): void => {
          if (docs.length >= MAX_FILES) return
          if (!matchGlob(glob, rel)) return
          let stat: fs.Stats
          try {
            stat = fs.statSync(abs)
          } catch {
            return
          }
          if (stat.size > MAX_FILE_BYTES) return
          let content: string
          try {
            content = fs.readFileSync(abs, "utf8")
          } catch {
            return
          }
          if (!/^[\t\n\r\x20-\x7e\xa0-\uffff]*$/.test(content)) return
          docs.push({ path: rel, content })
        }
        // A file root is scanned directly — the walker only ever yields files
        // inside a directory.
        const searchRoot = resolveSearchRoot(base)
        if (searchRoot.isFile && searchRoot.file) scan(searchRoot.file, path.basename(searchRoot.file))
        else walkFiles(base, scan)
      } catch {
        return textResult(`Search root not readable: ${base}`, /*isError*/ true)
      }
      if (docs.length === 0) return textResult(`No searchable files under ${base}`)
      const index = buildSemanticIndex(docs)
      const hits = searchSemanticIndex(index, query, topK)
      return textResult(formatSemanticResults(query, hits))
    },
  }
}
