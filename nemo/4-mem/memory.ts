/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"

export interface MemoryEntry {
  id: string
  content: string
  category: "preference" | "project" | "lesson" | "decision" | "context"
  timestamp: string
  sessionId?: string
}

const MEMORY_DIR = (): string => path.join(process.cwd(), "nemo", "4-mem")
const MEMORY_JSON = (): string => path.join(MEMORY_DIR(), "memory.json")
const USEMEMORY_MD = (): string => path.join(MEMORY_DIR(), "USEMEMORY.MD")
const MEMORY_MD = (): string => path.join(MEMORY_DIR(), "MEMORY.MD")
const MEMORY_MD_ARCHIVE = (): string => path.join(MEMORY_DIR(), "MEMORY.MD.archive")

const FORGET_MARKER = "USER_SAID_TO_FORGET_IT"

function ensureDir(): void {
  fs.mkdirSync(MEMORY_DIR(), { recursive: true })
}

function nextMemId(entries: { id?: string }[]): string {
  let max = 0
  for (const e of entries) {
    const m = (e.id ?? "").match(/MEM-(\d+)/)
    if (m) {
      const n = parseInt(m[1], 10)
      if (!Number.isNaN(n) && n > max) max = n
    }
  }
  const next = max + 1
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  return `MEM-${d}-${String(next).padStart(3, "0")}`
}

/**
 * Load MEMORY.md - the canonical append-only memory store
 * This is NEVER edited, only appended to.
 */
export function loadCanonicalMemory(): MemoryEntry[] {
  try {
    ensureDir()
    if (fs.existsSync(MEMORY_MD())) {
      const raw = fs.readFileSync(MEMORY_MD(), "utf8")
      return parseMemoryMd(raw)
    }
    return []
  } catch {
    return []
  }
}

/**
 * Load USEMEMORY.md - the editable interface for "user said to forget it" markers
 */
export function loadUseMemory(): MemoryEntry[] {
  try {
    ensureDir()
    if (fs.existsSync(USEMEMORY_MD())) {
      const raw = fs.readFileSync(USEMEMORY_MD(), "utf8")
      return parseMemoryMd(raw)
    }
    return []
  } catch {
    return []
  }
}

/**
 * Append entry to MEMORY.md (append-only, never edit/delete)
 * This is the canonical store that persists forever.
 */
export function appendToCanonicalMemory(entry: MemoryEntry): void {
  try {
    ensureDir()
    let existing = ""
    if (fs.existsSync(MEMORY_MD())) {
      existing = fs.readFileSync(MEMORY_MD(), "utf8")
    }

    const header = `# NEMOLABS - Persistent Memory (Append-Only / Canonical)

This file is the **canonical** persistent memory store. Entries here are appended automatically and **never deleted or edited**.
The assistant reads this file at the start of EVERY chat to load all historical context.

## Schema

Same fenced-block format as \`USEMEMORY.MD\`.

## Entries (auto-appended, never modify by hand)

<!-- Entries are appended here automatically. Do not edit by hand. -->

`

    const entryBlock = `### ${entry.id}
- created: ${entry.timestamp}
- category: ${entry.category}
- confidence: 1.0
- source: ${entry.sessionId ? `session_${entry.sessionId}` : "user"}
- last_used: ${new Date().toISOString()}
- use_count: 0
- tags: []

${entry.content}
`

    // If file doesn't exist or is empty, write header + entry
    if (!existing || existing.trim().length === 0) {
      fs.writeFileSync(MEMORY_MD(), header + entryBlock + "\n", "utf8")
    } else {
      // Append to existing file (after the header and any existing entries)
      // Find the end of the header comment and append there
      const lines = existing.split("\n")
      const headerEndIndex = lines.findIndex((line) => line.includes("Entries are appended here automatically"))
      if (headerEndIndex >= 0) {
        // Insert after the header comment line
        const newLines = [
          ...lines.slice(0, headerEndIndex + 1),
          "",
          entryBlock.trim(),
          ...lines.slice(headerEndIndex + 1),
        ]
        fs.writeFileSync(MEMORY_MD(), newLines.join("\n") + "\n", "utf8")
      } else {
        // Fallback: just append
        fs.writeFileSync(MEMORY_MD(), existing + "\n" + entryBlock + "\n", "utf8")
      }
    }
  } catch {
    // append failure is non-fatal
  }
}

/**
 * Write "user said to forget it" marker to USEMEMORY.md
 * This signals that the user requested history deletion.
 */
export function markUserForgetRequest(sessionId: string, reason: string = "user requested history deletion"): void {
  try {
    ensureDir()
    const entry: MemoryEntry = {
      id: `FORGET-${Date.now().toString(36)}`,
      content: `${FORGET_MARKER}: Session ${sessionId} - ${reason}`,
      category: "context",
      timestamp: new Date().toISOString(),
      sessionId,
    }

    let existing = ""
    if (fs.existsSync(USEMEMORY_MD())) {
      existing = fs.readFileSync(USEMEMORY_MD(), "utf8")
    }

    const header = `# NEMOLABS - User Memory (Editable Interface)

This is the **editable** memory store for explicit user requests.
When the user says "forget" or "delete history", a marker is written here.

## Schema

Each entry is a fenced block with YAML-like front-matter:

\`\`\`
### MEM-YYYYMMDD-NNN
- created: 2026-09-03T10:00:00Z
- category: preference | project | lesson | decision | context
- confidence: 0.0-1.0
- source: user | inferred | imported
- last_used: 2026-09-03T10:00:00Z
- use_count: 0
- tags: [comma, separated]

Free-form body — the actual memory.
\`\`\`

## Active entries

<!-- The assistant appends entries below. Do not edit by hand. -->

`

    const entryBlock = `### ${entry.id}
- created: ${entry.timestamp}
- category: ${entry.category}
- confidence: 1.0
- source: user
- last_used: ${new Date().toISOString()}
- use_count: 0
- tags: [forget]

${entry.content}
`

    if (!existing || existing.trim().length === 0) {
      fs.writeFileSync(USEMEMORY_MD(), header + entryBlock + "\n", "utf8")
    } else {
      fs.writeFileSync(USEMEMORY_MD(), existing + "\n" + entryBlock + "\n", "utf8")
    }
  } catch {
    // forget marker failure is non-fatal
  }
}

/**
 * Check if user has requested to forget (has FORGET marker in USEMEMORY.md)
 */
export function hasUserRequestedForget(): boolean {
  try {
    const entries = loadUseMemory()
    return entries.some((e) => e.content.includes(FORGET_MARKER))
  } catch {
    return false
  }
}

/**
 * Get the latest forget marker info
 */
export function getLatestForgetMarker(): MemoryEntry | null {
  try {
    const entries = loadUseMemory()
    const forgetEntries = entries.filter((e) => e.content.includes(FORGET_MARKER))
    if (forgetEntries.length === 0) return null
    return forgetEntries[forgetEntries.length - 1]
  } catch {
    return null
  }
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
    entries.push({ id, content, category, timestamp })
  }
  return entries
}

function serializeMemoryMd(entries: MemoryEntry[]): string {
  const header = `# Shrijan - User Memory (Editable Interface)

This is the **editable** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The canonical summarized store lives in \`MEMORY.MD\` and is read-only for the assistant — it can be searched but not appended to. Always check \`MEMORY.MD\` for older context.

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

The agent uses \`4-mem/memory.ts loadMemory\` to inject relevant entries into the system prompt based on the current task context. It also reads from \`MEMORY.MD\` for older summarized context.

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
  // Load from canonical MEMORY.md first (persistent, never deleted)
  const canonical = loadCanonicalMemory()
  if (canonical.length > 0) return canonical

  // Fallback to USEMEMORY.md (editable)
  try {
    ensureDir()
    if (fs.existsSync(USEMEMORY_MD())) {
      const raw = fs.readFileSync(USEMEMORY_MD(), "utf8")
      const parsed = parseMemoryMd(raw)
      if (parsed.length > 0) return parsed
    }
  } catch {}

  // Fallback to legacy JSON
  try {
    if (fs.existsSync(MEMORY_JSON())) {
      const raw = fs.readFileSync(MEMORY_JSON(), "utf8")
      return JSON.parse(raw) as MemoryEntry[]
    }
  } catch {}

  return []
}

export function saveMemory(entries: MemoryEntry[]): void {
  ensureDir()
  // For backward compatibility, still write to USEMEMORY.md and JSON
  // But the canonical store is MEMORY.md which is append-only
  fs.writeFileSync(USEMEMORY_MD(), serializeMemoryMd(entries), "utf8")
  fs.writeFileSync(MEMORY_JSON(), JSON.stringify(entries, null, 2), "utf8")
}

export function addMemory(
  content: string,
  category: MemoryEntry["category"] = "context",
  sessionId?: string,
): MemoryEntry {
  const all = loadMemory()
  const id = nextMemId(all)
  const entry: MemoryEntry = {
    id,
    content,
    category,
    timestamp: new Date().toISOString(),
    sessionId,
  }
  all.push(entry)
  saveMemory(all)
  return entry
}

export function searchMemory(query: string): MemoryEntry[] {
  const q = query.toLowerCase()
  return loadMemory().filter((m) => m.content.toLowerCase().includes(q) || m.category.includes(q))
}

export function getContextBlock(maxEntries = 8): string {
  const canonical = loadCanonicalMemory()
  const active = loadMemory().slice(-maxEntries)
  const entries = [...canonical, ...active].slice(-maxEntries)
  if (entries.length === 0) return ""
  const lines = entries.map((m) => `  - [${m.category}] ${m.content.slice(0, 150)}`)
  return ["## Persistent memory:", ...lines].join("\n")
}

/**
 * Get full memory context for system prompt injection at chat start
 * Includes canonical memory + forget marker if present
 */
export function getFullMemoryContext(): string {
  const canonical = loadCanonicalMemory()
  const forgetMarker = getLatestForgetMarker()

  const parts: string[] = []

  if (canonical.length > 0) {
    parts.push("## Persistent Memory (Canonical - Never Deleted):")
    for (const entry of canonical) {
      parts.push(`  - [${entry.category}] ${entry.content.slice(0, 300)}`)
    }
  }

  if (forgetMarker) {
    parts.push(`\n⚠️ USER REQUESTED HISTORY DELETION: ${forgetMarker.content}`)
    parts.push("The user has explicitly requested to forget previous context. Respect this request.")
  }

  return parts.length > 0 ? parts.join("\n") : ""
}

export function loadArchiveMemory(): MemoryEntry[] {
  try {
    ensureDir()
    if (fs.existsSync(MEMORY_MD_ARCHIVE())) {
      const raw = fs.readFileSync(MEMORY_MD_ARCHIVE(), "utf8")
      return parseMemoryMd(raw)
    }
    return []
  } catch {
    return []
  }
}

export function summarizeSessionToArchive(
  sessionId: string,
  summary: string,
  category: MemoryEntry["category"] = "context",
): void {
  try {
    ensureDir()
    const entry: MemoryEntry = {
      id: `SUM-${Date.now().toString(36)}`,
      content: `Session ${sessionId}: ${summary}`,
      category,
      timestamp: new Date().toISOString(),
      sessionId,
    }
    const existing = loadArchiveMemory()
    existing.push(entry)
    const header = `# Shrijan - User Memory (Archive / Read-Only)

This file is the **canonical** summarized memory store. Entries here are preserved forever and never modified by the assistant. The assistant can **read** this file to find long-forgotten context but must **never append** to it — use \`USEMEMORY.MD\` for new entries. Session summaries are appended here automatically.

## Schema (read-only)

Same fenced-block format as \`USEMEMORY.MD\`.

## Archived entries

<!-- Entries are appended here automatically. Do not edit by hand. -->

`
    const body = existing
      .map((m) => {
        const cat = m.category ?? "context"
        const created = m.timestamp ?? new Date().toISOString()
        return `### ${m.id}
- created: ${created}
- category: ${cat}
- confidence: 1.0
- source: session_summary
- last_used: ${new Date().toISOString()}
- use_count: 0
- tags: []

${m.content}`
      })
      .join("\n\n")
    fs.writeFileSync(MEMORY_MD_ARCHIVE(), header + body + "\n", "utf8")
  } catch {
    // archive failure is non-fatal
  }
}

export function exportMemory(): string {
  return JSON.stringify(loadMemory(), null, 2)
}

export function importMemory(raw: string): number {
  try {
    const entries = JSON.parse(raw) as MemoryEntry[]
    if (!Array.isArray(entries)) return 0
    const valid = entries.filter((e) => e.content && e.category)
    saveMemory([...loadMemory(), ...valid])
    return valid.length
  } catch {
    return 0
  }
}

/**
 * Process user prompt: capture, summarize, and append to MEMORY.md (canonical, append-only)
 * Called on EVERY user prompt in EVERY chat.
 */
export function processUserPrompt(prompt: string, sessionId: string, responseSummary?: string): void {
  try {
    // Create summary entry for the user prompt
    const summaryContent = responseSummary
      ? `User: ${prompt.slice(0, 200)}\nAssistant: ${responseSummary.slice(0, 300)}`
      : `User: ${prompt.slice(0, 500)}`

    const entry: MemoryEntry = {
      id: `CHAT-${Date.now().toString(36)}`,
      content: summaryContent,
      category: "context",
      timestamp: new Date().toISOString(),
      sessionId,
    }

    // Append to canonical MEMORY.md (never deleted, never edited)
    appendToCanonicalMemory(entry)
  } catch {
    // memory capture failure is non-fatal
  }
}

/**
 * Handle "forget" / "delete history" request from user
 * Writes FORGET marker to USEMEMORY.md and returns confirmation message
 */
export function handleForgetRequest(sessionId: string, confirmed: boolean): { success: boolean; message: string } {
  if (!confirmed) {
    return {
      success: false,
      message: "History deletion cancelled. Your persistent memory remains intact.",
    }
  }

  // Write forget marker to USEMEMORY.md
  markUserForgetRequest(sessionId, "user confirmed history deletion via /forget command")

  return {
    success: true,
    message:
      "History deletion confirmed. A 'forget' marker has been recorded. The assistant will respect this request in future chats.",
  }
}

/**
 * Check if prompt is a forget/delete history request
 */
export function isForgetRequest(prompt: string): boolean {
  const lower = prompt.toLowerCase().trim()
  return (
    lower === "/forget" ||
    lower === "/delete history" ||
    lower === "forget history" ||
    lower === "delete my history" ||
    lower === "clear memory" ||
    lower.startsWith("/forget ") ||
    (lower.startsWith("forget ") && lower.includes("history"))
  )
}

export function memoryMdPath(): string {
  return MEMORY_MD()
}

export function memoryJsonPath(): string {
  return MEMORY_JSON()
}

export function memoryArchivePath(): string {
  return MEMORY_MD_ARCHIVE()
}

/**
 * Get path to USEMEMORY.md (editable interface)
 */
export function useMemoryMdPath(): string {
  return USEMEMORY_MD()
}

/**
 * Get path to MEMORY.md (canonical append-only)
 */
export function canonicalMemoryMdPath(): string {
  return MEMORY_MD()
}
