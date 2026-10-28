/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as os from "os"
import path from "path"
import { createHash } from "crypto"

import { Tool } from "../types.js"
import type { ToolResult } from "../types.js"

/** Nemo memory layer — active store is USEMEMORY.MD, archive is MEMORY.MD (read-only). */
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
  return path.join(os.homedir(), ".nemo", "memory", "memory.json")
}

export function useMemoryFile(): string {
  return path.join(projectRoot(), "nemo", "4-mem", "USEMEMORY.MD")
}

export function archiveMemoryFile(): string {
  return path.join(projectRoot(), "nemo", "4-mem", "MEMORY.MD")
}

function projectRoot(): string {
  if (process.env.NEMO_HOME && fs.existsSync(path.join(process.env.NEMO_HOME, "package.json"))) {
    return process.env.NEMO_HOME
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

/** Metadata keys the block parser recognises. A line that is not one of
 *  these ends the metadata section, so a memory body that starts with a
 *  bullet ("- Fix the parser: later") is never mistaken for metadata. */
const MEMORY_META_KEYS = new Set([
  "created",
  "category",
  "title",
  "confidence",
  "source",
  "last_used",
  "use_count",
  "tags",
  "links",
  "expires",
])

/** One-line-safe metadata value: a newline would split the block and the
 *  parser would read the remainder as the body. */
function oneLine(value: string | undefined): string {
  return (value ?? "").replace(/[\r\n]+/g, " ").trim()
}

function parseBracketList(raw: string | undefined): string[] {
  if (!raw) return []
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "")
  return inner
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
}

/** Prose that only the store's OWN header carries. A block whose body is the
 *  header is a phantom the legacy serializer wrote back into the store — the
 *  file describing itself, not a memory the user asked to keep. */
const PHANTOM_BODY_MARKERS = [
  "This is the **active** memory store",
  "This file is the **canonical** summarized memory store",
]

/** The schema illustration in the store header ends with this line. */
const SCHEMA_BODY_MARKER = "Free-form body"

/** A body that STARTS with a metadata line is a metadata block, not a memory:
 *  the legacy serializer wrote the front-matter twice and the body was lost. */
const METADATA_BODY_START = /^- (created|category|title|confidence|source|last_used|use_count|tags|links|expires):/

/** True when a block body carries a memory worth keeping. */
function isRealBody(content: string): boolean {
  const trimmed = content.trim()
  if (!trimmed) return false
  if (METADATA_BODY_START.test(trimmed)) return false
  if (content.includes(SCHEMA_BODY_MARKER)) return false
  return !PHANTOM_BODY_MARKERS.some((marker) => content.includes(marker))
}

/** Stable id for a block whose own id is unusable — derived from the body so
 *  repeated loads of the same file produce the same id (no duplicates). */
function recoveredId(content: string): string {
  return `mem_${createHash("sha1").update(content).digest("hex").slice(0, 10)}`
}

export interface ParsedMemoryMd {
  readonly entries: MemoryEntry[]
  /** Blocks that looked like entries but carried no memory (header phantoms,
   *  metadata-only rows). A non-zero count means the file is still in the
   *  legacy shape and can be rewritten in the canonical one. */
  readonly dropped: number
}

function parseMemoryMd(raw: string): ParsedMemoryMd {
  const entries: MemoryEntry[] = []
  let dropped = 0
  // serializeMemoryMd prepends a prose header whose fenced schema block
  // contains a literal `### MEM-YYYYMMDD-NNN` line — splitting the WHOLE file
  // fed the header text and the schema fragment back as phantom entries (the
  // store grew by two junk rows per save, and they were injected into prompts
  // like real memories). Real entries only live below the "## Active entries"
  // marker; parse from there (legacy hand-written files without the marker
  // fall back to the whole raw text).
  const marker = "## Active entries"
  const start = raw.indexOf(marker)
  const body = start >= 0 ? raw.slice(start) : raw
  // The chunk before the first "### " is the preamble ("## Active entries" plus
  // the do-not-edit comment), not an entry. A file that STARTS with an entry
  // has an empty preamble and keeps every chunk.
  const chunks = body.split(/^### /m)
  const preamble = /^\s*##\s/.test(chunks[0] ?? "")
  const blocks = (preamble ? chunks.slice(1) : chunks).filter((b) => b.trim().length > 0)
  for (const block of blocks) {
    const idMatch = block.match(/^([^\n]+)\n/)
    const rawId = idMatch ? idMatch[1].trim() : ""
    // The metadata section is the run of `- key: value` lines after the id,
    // terminated by the blank line the serializer writes before the body.
    // Parsing it by KEY instead of by line count is what lets the title, the
    // tags and the expiry survive a save -> load round trip; the old fixed
    // count silently dropped every field the serializer did not write, which
    // is why a saved title came back as `undefined`.
    const lines = block.split(/\r?\n/)
    const meta: Record<string, string> = {}
    let i = 1
    for (; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim() === "") {
        i++
        break
      }
      const m = /^- ([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$/.exec(line)
      if (!m || !MEMORY_META_KEYS.has(m[1])) break
      meta[m[1]] = m[2].trim()
    }
    const content = lines.slice(i).join("\n").trim()
    // A block with no real body is a lost entry (or a header phantom). It is
    // dropped, and counted, so the store can be repaired instead of staying
    // unreadable forever — which is what left the live store empty.
    if (!isRealBody(content)) {
      dropped++
      continue
    }
    const id = /^(mem_[a-z0-9]+|MEM-\d+)$/.test(rawId) ? rawId : recoveredId(content)
    const category = (meta.category as MemoryEntry["category"]) ?? "context"
    const timestamp = meta.created ?? new Date().toISOString()
    const tags = parseBracketList(meta.tags)
    const links = [...new Set([...parseBracketList(meta.links), ...extractLinks(content)])]
    const title = meta.title && meta.title.length > 0 ? meta.title : undefined
    const frontmatter = meta.expires ? { expires: meta.expires } : undefined
    entries.push({ id, content, category, timestamp, tags, createdAt: timestamp, title, links, frontmatter })
  }
  return { entries, dropped }
}

function serializeMemoryMd(entries: MemoryEntry[]): string {
  const header = `# Shrijan - User Memory (Active)

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in \`MEMORY.MD\` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

\`\`\`
### MEM-YYYYMMDD-NNN
- created: 2026-09-03T10:00:00Z
- category: preference | fact | project | person | tool | workflow
- title: Short human title
- confidence: 0.0-1.0
- source: user | inferred | imported
- last_used: 2026-09-03T10:00:00Z
- use_count: 0
- tags: [comma, separated]
- links: [wiki, style, links]

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
      const meta = [
        `- created: ${created}`,
        `- category: ${cat}`,
        `- title: ${oneLine(m.title)}`,
        `- confidence: 1.0`,
        `- source: user`,
        `- last_used: ${new Date().toISOString()}`,
        `- use_count: 0`,
        `- tags: [${(m.tags ?? []).map(oneLine).filter(Boolean).join(", ")}]`,
        `- links: [${(m.links ?? []).map(oneLine).filter(Boolean).join(", ")}]`,
      ]
      const expires = oneLine(m.frontmatter?.expires)
      if (expires) meta.push(`- expires: ${expires}`)
      return `### ${m.id}\n${meta.join("\n")}\n\n${m.content}`
    })
    .join("\n\n")
  return header + body + "\n"
}

export function loadMemory(): MemoryEntry[] {
  try {
    const md = readMdStore()
    const legacy = readLegacyStore()
    const merged = mergeEntries(md.entries, legacy)
    // A store that still parses in the legacy shape lost every entry it
    // carried. Rewrite it once in the canonical shape; afterwards it parses
    // cleanly and the store is usable again.
    if (md.dropped > 0) repairMemoryStore(merged)
    return merged.filter((e) => !isExpiredEntry(e))
  } catch {
    return []
  }
}

function readMdStore(): ParsedMemoryMd {
  const file = useMemoryFile()
  if (!fs.existsSync(file)) return { entries: [], dropped: 0 }
  return parseMemoryMd(fs.readFileSync(file, "utf8"))
}

function readLegacyStore(): MemoryEntry[] {
  const file = memoryFile()
  if (!fs.existsSync(file)) return []
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as MemoryEntry[]
  if (!Array.isArray(parsed)) return []
  return parsed.filter((e) => e && typeof e.content === "string")
}

/** Merge the MD store with the JSON sidecar, newest last.
 *
 *  The two stores are written together but not equally durable: the MD lives
 *  next to the install (read-only in a hardened setup), the JSON lives in the
 *  user's home. When the MD write fails, the sidecar is the only place the
 *  memory survived — so both are read and merged by id, and the union is
 *  ordered by creation time so "the last N entries" means "the newest N".
 */
function mergeEntries(primary: MemoryEntry[], secondary: MemoryEntry[]): MemoryEntry[] {
  const byId = new Map<string, MemoryEntry>()
  for (const entry of primary) {
    if (entry.id) byId.set(entry.id, entry)
  }
  for (const entry of secondary) {
    if (!entry.id) continue
    if (!byId.has(entry.id)) byId.set(entry.id, entry)
  }
  const seen = new Set<string>()
  const out: MemoryEntry[] = []
  for (const entry of byId.values()) {
    const key = contentKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  out.sort((a, b) => entryTime(a) - entryTime(b))
  return out
}

function entryTime(entry: MemoryEntry): number {
  const raw = entry.timestamp ?? entry.createdAt
  const parsed = raw ? Date.parse(raw) : NaN
  return Number.isNaN(parsed) ? 0 : parsed
}

/** Rewrite the MD store in the canonical shape (best effort — a read-only
 *  install dir must never break a read). */
function repairMemoryStore(entries: MemoryEntry[]): void {
  try {
    fs.mkdirSync(path.dirname(useMemoryFile()), { recursive: true })
    fs.writeFileSync(useMemoryFile(), serializeMemoryMd(entries), "utf8")
  } catch {
    /* keep the JSON sidecar as the source of truth */
  }
}

export function saveMemory(entries: MemoryEntry[]): void {
  // TWO separate trees: USEMEMORY.MD lives under the project root, but the
  // legacy JSON lives under homedir/.nemo/memory/. On a fresh profile
  // neither exists — mkdir-ing only the first made the memory.json write
  // below throw ENOENT (caught by the harness as a broken tool). Each writer
  // creates its own directory.
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
  // The JSON sidecar is written FIRST: it lives in the user's home and is
  // always writable, while the MD store sits next to the install and can be
  // read-only. A failed MD write must not take the memory down with it.
  fs.mkdirSync(path.dirname(memoryFile()), { recursive: true })
  fs.writeFileSync(memoryFile(), JSON.stringify(deduped, null, 2), "utf8")
  try {
    fs.mkdirSync(path.dirname(useMemoryFile()), { recursive: true })
    fs.writeFileSync(useMemoryFile(), serializeMemoryMd(deduped), "utf8")
  } catch {
    /* the sidecar already holds the memory */
  }
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
  const candidates = pickContextEntries(64, query)
  const lines: string[] = []
  let totalTokens = 0
  for (const m of candidates) {
    const snippet = `  - [${m.category ?? "context"}] ${contextText(m)}`
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

/** One context line per memory: the title (when it has one) then the body. */
function contextText(entry: MemoryEntry): string {
  const body = entry.content.replace(/\s+/g, " ").trim().slice(0, 150)
  const title = entry.title?.trim()
  // The save path defaults the title to the body's first words, so the same
  // text would otherwise be printed twice.
  if (!title || body.startsWith(title)) return body
  return `${title}: ${body}`
}

/** The memories that go into the prompt.
 *
 *  Without a query that is simply the newest N. With one, the relevant
 *  memories come first and the remaining slots are filled with the newest
 *  ones — a resumed session surfaces what it is about without losing the
 *  recency the plain block relies on.
 */
function pickContextEntries(maxEntries: number, query?: string): MemoryEntry[] {
  const all = loadActiveMemories()
  if (all.length === 0) return []
  const q = (query ?? "").trim()
  if (!q) return all.slice(-maxEntries)
  const ranked = recallMemory(q, all.length)
  if (ranked.length === 0) return all.slice(-maxEntries)
  const chosen: MemoryEntry[] = []
  const used = new Set<string>()
  for (const entry of ranked) {
    if (chosen.length >= maxEntries) break
    chosen.push(entry)
    used.add(entry.id)
  }
  for (let i = all.length - 1; i >= 0 && chosen.length < maxEntries; i--) {
    const entry = all[i]!
    if (used.has(entry.id)) continue
    chosen.push(entry)
    used.add(entry.id)
  }
  return chosen
}

export function getContextBlock(maxEntries = 8, query?: string): string {
  const entries = pickContextEntries(maxEntries, query)
  if (entries.length === 0) return ""
  const lines = entries.map((m) => `  - [${m.category ?? "context"}] ${contextText(m)}`)
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

/** Display label for an entry: the title when it has one, otherwise the head
 *  of the body. An entry without a title used to render as the literal
 *  string "undefined" in `memory list`. */
export function memoryLabel(entry: MemoryEntry): string {
  const title = entry.title?.trim()
  if (title) return title
  return entry.content.replace(/\s+/g, " ").trim().slice(0, 48) || "(empty)"
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
            ? hits.map((m) => `[${m.id}] ${memoryLabel(m)}: ${m.content}`).join("\n")
            : `No memories match "${a.query}"`
          return { isError: false, content: [{ type: "text", text }] }
        }
        case "list": {
          const text = entries.length
            ? entries
                .map(
                  (m) =>
                    `[${m.id}] ${memoryLabel(m)} (${m.createdAt.slice(0, 10)})${m.links?.length ? ` -> ${m.links.join(", ")}` : ""}`,
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
