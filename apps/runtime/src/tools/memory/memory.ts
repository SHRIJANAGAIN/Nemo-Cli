/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as os from "os"
import path from "path"

import { Tool } from "../types.js"
import type { ToolResult } from "../types.js"

/** SKT memory layer — active store is USEMEMORY.MD, archive is MEMORY.MD (read-only). */
export interface MemoryEntry {
  id: string
  title?: string
  content: string
  tags: string[]
  createdAt: string
  category?: string
  timestamp?: string
  frontmatter?: MemoryFrontmatter
  links?: string[]
  sessionId?: string
}

export interface MemoryFrontmatter {
  category?: string
  source?: string
  related?: string[]
  expires?: string
  [key: string]: string | string[] | undefined
}

export function memoryFile(): string {
  return path.join(os.homedir(), ".trayambak", "memory", "memory.json")
}

export function useMemoryFile(): string {
  return path.join(projectRoot(), "skt", "4-mem", "USEMEMORY.MD")
}

export function archiveMemoryFile(): string {
  return path.join(projectRoot(), "skt", "4-mem", "MEMORY.MD")
}

function projectRoot(): string {
  if (process.env.TRAYAMBAK_HOME && fs.existsSync(path.join(process.env.TRAYAMBAK_HOME, "package.json"))) {
    return process.env.TRAYAMBAK_HOME
  }
  let dir = __dirname
  for (let i = 0; i < 16; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

function parseFrontmatter(text: string): { frontmatter: MemoryFrontmatter | undefined; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!match) return { frontmatter: undefined, body: text }
  const fm: MemoryFrontmatter = {}
  for (const line of match[1].split("\n")) {
    const [key, ...rest] = line.split(":")
    if (!key || rest.length === 0) continue
    const value = rest.join(":").trim()
    if (value.startsWith("[") && value.endsWith("]")) {
      fm[key.trim()] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    } else {
      fm[key.trim()] = value
    }
  }
  return { frontmatter: fm, body: text.slice(match[0].length) }
}

function extractLinks(text: string): string[] {
  const linkRe = /\[\[([^\]]+)\]\]/g
  const links: string[] = []
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(text)) !== null) {
    links.push(m[1])
  }
  return links
}

function nextMemId(entries: MemoryEntry[]): string {
  const max = entries.reduce((max, entry) => {
    const match = entry.id.match(/^MEM-(\d+)$/)
    if (!match) return max
    const num = Number(match[1])
    return num > max ? num : max
  }, 0)
  return `MEM-${String(max + 1).padStart(8, "0")}`
}

function parseMemoryMd(raw: string): MemoryEntry[] {
  const entries: MemoryEntry[] = []
  const blocks = raw.split(/^### /m).filter((b) => b.trim().length > 0)
  for (const block of blocks) {
    const idMatch = block.match(/^([^\n]+)\n/)
    const id = idMatch ? idMatch[1].trim() : `mem_${Math.random().toString(36).slice(2, 9)}`
    const categoryMatch = block.match(/- category:\s*(\w+)/)
    const createdMatch = block.match(/- created:\s*([^\n]+)/)
    const bodyMatch = block.match(/- category:[^\n]+\n(?:- [^\n]+\n){6}\n?([\s\S]*)/)
    const content = bodyMatch ? bodyMatch[1].trim() : block.replace(/^[^\n]+\n/, "").trim()
    const category = (categoryMatch?.[1] as MemoryEntry["category"]) ?? "context"
    const timestamp = createdMatch?.[1]?.trim() ?? new Date().toISOString()
    const tagsMatch = block.match(/- tags:\s*\[([^\]]*)\]/)
    const tags = tagsMatch
      ? tagsMatch[1]
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : []
    entries.push({ id, content, category, timestamp, tags, createdAt: timestamp })
  }
  return entries
}

function serializeMemoryMd(entries: MemoryEntry[]): string {
  const header = `# SKT AI LABS - User Memory (Active)

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in \`MEMORY.MD\` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

\`\`\`
### MEM-YYYYMMDD-NNN
- created: 2026-09-03T10:00:00Z
- category: preference | fact | project | person | tool | workflow
- confidence: 0.0-1.0
- source: user | inferred | imported
- last_used: 2026-09-03T10:00:00Z
- use_count: 0
- tags: [comma, separated]

Free-form body — the actual memory.
\`\`\`

The agent uses \`4-mem/memory.ts loadMemory\` to inject relevant entries into the system prompt based on the current task context.

## Active entries

<!-- The assistant appends entries below. Do not edit by hand. -->

`
  const body = entries
    .map((m) => {
      const cat = m.category ?? "context"
      const created = m.timestamp ?? new Date().toISOString()
      return `### ${m.id}
- created: ${created}
- category: ${cat}
- confidence: 1.0
- source: user
- last_used: ${new Date().toISOString()}
- use_count: 0
- tags: []

${m.content}`
    })
    .join("\n\n")
  return header + body + "\n"
}

export function loadMemory(): MemoryEntry[] {
  try {
    if (fs.existsSync(useMemoryFile())) {
      const raw = fs.readFileSync(useMemoryFile(), "utf8")
      const parsed = parseMemoryMd(raw)
      if (parsed.length > 0) return parsed.filter((e) => !isExpiredEntry(e))
    }
    if (fs.existsSync(memoryFile())) {
      const raw = fs.readFileSync(memoryFile(), "utf8")
      const legacy = JSON.parse(raw) as MemoryEntry[]
      if (Array.isArray(legacy) && legacy.length > 0) {
        const active = legacy.filter((e) => !isExpiredEntry(e))
        saveMemory(active)
        return active
      }
    }
    return []
  } catch {
    return []
  }
}

export function saveMemory(entries: MemoryEntry[]): void {
  fs.mkdirSync(path.dirname(useMemoryFile()), { recursive: true })
  const active = entries.filter((e) => !isExpiredEntry(e))
  const seen = new Set<string>()
  const deduped: MemoryEntry[] = []
  for (const e of active) {
    const key = contentKey(e)
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(e)
    }
  }
  fs.writeFileSync(useMemoryFile(), serializeMemoryMd(deduped), "utf8")
  fs.writeFileSync(memoryFile(), JSON.stringify(deduped, null, 2), "utf8")
}

export function addMemory(
  content: string,
  category: MemoryEntry["category"] = "context",
  sessionId?: string,
): MemoryEntry {
  const all = loadActiveMemories()
  const key = contentKey({ content, title: "", category })
  const existing = all.find((e) => contentKey(e) === key)
  if (existing) return existing
  const id = nextMemId(all)
  const entry: MemoryEntry = {
    id,
    content,
    category,
    timestamp: new Date().toISOString(),
    sessionId,
    tags: [],
    createdAt: new Date().toISOString(),
  }
  all.push(entry)
  saveMemory(all)
  return entry
}

function isExpiredEntry(entry: MemoryEntry): boolean {
  const expires = entry.frontmatter?.expires
  if (!expires) return false
  const expDate = new Date(expires)
  if (!isNaN(expDate.getTime())) return expDate <= new Date()
  const expMeta = (entry as MemoryEntry & { expiresAt?: string }).expiresAt
  if (expMeta) {
    const d = new Date(expMeta)
    if (!isNaN(d.getTime())) return d <= new Date()
  }
  return false
}

function loadActiveMemories(): MemoryEntry[] {
  return loadMemory()
}

function computeRelevance(entry: MemoryEntry, query: string): number {
  const q = query.toLowerCase()
  const content = entry.content.toLowerCase()
  const title = (entry.title ?? "").toLowerCase()
  const tags = (entry.tags ?? []).map((t) => t.toLowerCase())
  let score = 0
  if (title.includes(q)) score += 10
  if (content.includes(q)) score += 5
  for (const tag of tags) {
    if (tag === q) score += 8
    else if (tag.includes(q)) score += 3
  }
  if (entry.category?.toLowerCase().includes(q)) score += 2
  if (entry.links?.some((l) => l.toLowerCase().includes(q))) score += 1
  const words = q.split(/\s+/)
  let matchedWords = 0
  for (const w of words) {
    if (w.length > 2 && content.includes(w)) matchedWords++
  }
  score += matchedWords
  return score
}

function countTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3.5)
}

export function recallMemory(query: string, topK = 10): MemoryEntry[] {
  const candidates = loadActiveMemories()
  if (!query.trim()) return candidates.slice(0, topK)
  const scored = candidates.map((entry) => ({ entry, score: computeRelevance(entry, query) }))
  scored.sort((a, b) => b.score - a.score)
  return scored
    .filter((s) => s.score > 0)
    .slice(0, topK)
    .map((s) => s.entry)
}

export function getTokenSafeContext(maxTokens = 4096, query?: string): string {
  let candidates = loadActiveMemories()
  if (query) candidates = recallMemory(query, candidates.length)
  const lines: string[] = []
  let totalTokens = 0
  for (const m of candidates) {
    const snippet = `  - [${m.category}] ${m.content.slice(0, 150)}`
    const tokens = countTokens(snippet)
    if (totalTokens + tokens > maxTokens && lines.length > 0) break
    lines.push(snippet)
    totalTokens += tokens
  }
  if (lines.length === 0) return ""
  return ["## Persistent memory:", ...lines].join("\n")
}

export function searchMemory(query: string): MemoryEntry[] {
  return recallMemory(query, 50)
}

export function getContextBlock(maxEntries = 8): string {
  const entries = loadActiveMemories().slice(-maxEntries)
  if (entries.length === 0) return ""
  const lines = entries.map((m) => `  - [${m.category}] ${m.content.slice(0, 150)}`)
  return ["## Persistent memory:", ...lines].join("\n")
}

export function exportMemory(): string {
  return JSON.stringify(loadMemory(), null, 2)
}

export function importMemory(raw: string): number {
  try {
    const entries = JSON.parse(raw) as MemoryEntry[]
    if (!Array.isArray(entries)) return 0
    const valid = entries.filter((e) => e.content && e.category)
    const existing = loadMemory()
    const existingKeys = new Set(existing.map((e) => contentKey(e)))
    const fresh = valid.filter((e) => !existingKeys.has(contentKey(e)))
    saveMemory([...existing, ...fresh])
    return fresh.length
  } catch {
    return 0
  }
}

function contentKey(entry: { content: string; title?: string; category?: string }): string {
  const title = (entry.title ?? "").toLowerCase().trim()
  const content = entry.content.toLowerCase().trim()
  if (title && content) return `${title}|||${content}`
  return content
}

export function memoryMdPath(): string {
  return useMemoryFile()
}

export function memoryJsonPath(): string {
  return memoryFile()
}

export function memoryArchivePath(): string {
  return archiveMemoryFile()
}

export function memoryContextBlock(maxEntries = 12): string {
  return getContextBlock(maxEntries)
}

/** One auto-extractable fact found in turn text (EXTRACT_MEMORIES port:
 *  ccb mines session text for reusable facts; ours is a conservative
 *  no-LLM heuristic — high-signal phrasing only, capped per turn). */
export interface MemoryCandidate {
  content: string
  category: string
}

const EXTRACT_PATTERNS: Array<{ re: RegExp; category: string }> = [
  { re: /\bremember\s+(?:that\s+)?([^.\n!?]{8,220})/i, category: "preference" },
  { re: /\bmy\s+name\s+is\s+([^.\n!?]{2,60})/i, category: "context" },
  { re: /\bi\s+prefer\s+([^.\n!?]{4,220})/i, category: "preference" },
  { re: /\balways\s+([^.\n!?]{4,220})/i, category: "preference" },
  { re: /\bnever\s+([^.\n!?]{4,220})/i, category: "preference" },
  { re: /\bwe\s+decided\s+(?:that\s+)?([^.\n!?]{8,220})/i, category: "decision" },
  { re: /\bnote\s*:\s*([^.\n!?]{8,220})/i, category: "context" },
  { re: /\bmy\s+[a-z][a-z ]{1,24}\s+is\s+([^.\n!?]{2,120})/i, category: "context" },
]

/** Transient-state words: a "my X is broken" sentence is not a keeper
 *  unless the user explicitly said remember/note/decided. */
const TRANSIENT_RE = /\b(broken|error|fail|wrong|bug|stuck|crash|not working)\b/i

function cleanCandidate(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'({\[]+|["')}\].;:,]+$/g, "")
    .trim()
}

/** Scan turn text for keeper facts. Pure (no fs) — capped, deduped,
 *  transient-state filtered. At most `max` candidates, first-match wins
 *  per sentence. */
export function extractMemoryCandidates(text: string, max = 2): MemoryCandidate[] {
  const out: MemoryCandidate[] = []
  const seen = new Set<string>()
  const sentences = String(text ?? "").split(/[.\n!?]+/)
  for (const sentence of sentences) {
    if (out.length >= max) break
    const s = sentence.trim()
    if (s.length < 8) continue
    for (let i = 0; i < EXTRACT_PATTERNS.length; i++) {
      const p = EXTRACT_PATTERNS[i] as { re: RegExp; category: string }
      const m = p.re.exec(s)
      if (!m) continue
      const content = cleanCandidate(m[1] ?? m[0] ?? "")
      if (content.length < 2 || content.length > 240) break
      const key = content.toLowerCase()
      if (seen.has(key)) break
      // remember/note/decided (patterns 0, 5, 6) are explicit — always keep.
      const explicit = i === 0 || i === 5 || i === 6
      if (!explicit && TRANSIENT_RE.test(s)) break
      seen.add(key)
      out.push({ content, category: p.category })
      break
    }
  }
  return out
}

/** Extract + persist keeper facts. Returns only FRESH entries (addMemory
 *  returns the existing row on dupes — those are filtered here so callers
 *  can report honestly). Never throws — auto-memory must not break turns. */
export function extractAndStoreMemories(text: string, sessionId?: string, max = 2): MemoryEntry[] {
  try {
    const known = new Set(loadMemory().map((e) => e.content.toLowerCase().trim()))
    const stored: MemoryEntry[] = []
    for (const c of extractMemoryCandidates(text, max)) {
      try {
        const key = c.content.toLowerCase().trim()
        if (known.has(key)) continue
        known.add(key)
        stored.push(addMemory(c.content, c.category, sessionId))
      } catch {
        /* one bad write skips, the rest still land */
      }
    }
    return stored
  } catch {
    return []
  }
}

export function createMemoryTool(): Tool {
  return {
    definition: {
      timeoutMs: 30_000,
      name: "memory",
      description:
        "Persistent long-term memory across sessions. Save important facts, user preferences, " +
        "project decisions or lessons learned; search them later; list or forget entries. Supports YAML frontmatter and [[wiki-style links]].",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "save | search | list | forget | link",
            enum: ["save", "search", "list", "forget", "link"],
          },
          title: { type: "string", description: "Short title (for save)" },
          content: {
            type: "string",
            description: "The fact/lesson to remember (for save). Supports YAML frontmatter and [[links]].",
          },
          tags: { type: "string", description: "Comma-separated tags (for save, optional)" },
          query: { type: "string", description: "Text to search for (for search)" },
          id: { type: "string", description: "Entry id (for forget)" },
          link: { type: "string", description: "Target entry id or title to link (for link)" },
        },
        required: ["action"],
      },
    },
    async execute(_id, args): Promise<ToolResult> {
      const a = args as {
        action: string
        title?: string
        content?: string
        tags?: string
        query?: string
        id?: string
        link?: string
      }
      let entries = loadMemory()
      switch (a.action) {
        case "save": {
          if (!a.content)
            return { isError: true, content: [{ type: "text", text: "memory.save: 'content' is required" }] }
          const { frontmatter, body } = parseFrontmatter(a.content)
          const links = extractLinks(body)
          const entry: MemoryEntry = {
            id: `mem_${Date.now().toString(36)}`,
            title: a.title?.trim() || body.slice(0, 48),
            content: body,
            tags: (a.tags ?? "")
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
            createdAt: new Date().toISOString(),
            frontmatter: frontmatter as MemoryFrontmatter | undefined,
            links,
          }
          entries = entries.filter((e) => contentKey(e) !== contentKey(entry))
          entries.push(entry)
          saveMemory(entries)
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: `Saved ${entry.id}: ${entry.title}${links.length ? ` (links: ${links.join(", ")})` : ""}`,
              },
            ],
          }
        }
        case "search": {
          const q = (a.query ?? "").toLowerCase()
          if (!q) return { isError: true, content: [{ type: "text", text: "memory.search: 'query' is required" }] }
          const hits = searchMemory(a.query ?? "")
          const text = hits.length
            ? hits.map((m) => `[${m.id}] ${m.title}: ${m.content}`).join("\n")
            : `No memories match "${a.query}"`
          return { isError: false, content: [{ type: "text", text }] }
        }
        case "list": {
          const text = entries.length
            ? entries
                .map(
                  (m) =>
                    `[${m.id}] ${m.title} (${m.createdAt.slice(0, 10)})${m.links?.length ? ` -> ${m.links.join(", ")}` : ""}`,
                )
                .join("\n")
            : "Memory is empty."
          return { isError: false, content: [{ type: "text", text }] }
        }
        case "forget": {
          if (!a.id) return { isError: true, content: [{ type: "text", text: "memory.forget: 'id' is required" }] }
          const kept = entries.filter((m) => m.id !== a.id)
          if (kept.length === entries.length)
            return { isError: true, content: [{ type: "text", text: `No memory with id ${a.id}` }] }
          saveMemory(kept)
          return { isError: false, content: [{ type: "text", text: `Forgot ${a.id}` }] }
        }
        case "link": {
          const sourceId = a.id
          const target = a.link
          if (!sourceId || !target)
            return { isError: true, content: [{ type: "text", text: "memory.link: 'id' and 'link' are required" }] }
          const source = entries.find((m) => m.id === sourceId)
          if (!source)
            return { isError: true, content: [{ type: "text", text: `memory.link: source ${sourceId} not found` }] }
          const links = source.links ?? []
          if (!links.includes(target)) {
            source.links = [...links, target]
            saveMemory(entries)
          }
          return { isError: false, content: [{ type: "text", text: `Linked ${sourceId} -> ${target}` }] }
        }
        default:
          return { isError: true, content: [{ type: "text", text: `Unknown memory action: ${a.action}` }] }
      }
    },
  }
}
