/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { loadMemory, saveMemory, type MemoryEntry } from "./memory.js"
import { textResult, type Tool } from "../types.js"

export const DREAM_MAX_ENTRIES = 200
export const DREAM_MAX_BYTES = 25 * 1024

export interface DreamContradiction {
  aId: string
  bId: string
  reason: string
}

export interface DreamPlan {
  keep: MemoryEntry[]
  dropExpiredIds: string[]
  dropDupeIds: string[]
  contradictions: DreamContradiction[]
  relativeDateIds: string[]
  capped: number
  bytesBefore: number
  bytesAfter: number
}

function normalizeContent(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

function entryTimestamp(e: MemoryEntry): number {
  const raw = e.timestamp ?? e.createdAt ?? ""
  const t = Date.parse(raw)
  return Number.isNaN(t) ? 0 : t
}

function isExpired(e: MemoryEntry, now: number): boolean {
  const expires = e.frontmatter?.expires
  if (typeof expires !== "string" || expires.trim().length === 0) return false
  const t = Date.parse(expires.trim())
  if (Number.isNaN(t)) return false
  return t <= now
}

const RELATIVE_DATE_RE = /\b(today|tomorrow|yesterday|next week|last week|this weekend)\b/i

function subjectKey(normalized: string): string {
  return normalized.split(" ").slice(0, 3).join(" ")
}

function indexBytes(entries: MemoryEntry[]): number {
  let total = 0
  for (const e of entries) total += Buffer.byteLength(String(e.content ?? ""), "utf8") + 64
  return total
}

/** Deterministic consolidation plan. Pure: no fs, no network. */
export function planDreamConsolidation(entries: MemoryEntry[], now = Date.now()): DreamPlan {
  const bytesBefore = indexBytes(entries)
  const dropExpiredIds: string[] = []
  const live = entries.filter((e) => {
    if (isExpired(e, now)) {
      dropExpiredIds.push(e.id)
      return false
    }
    return true
  })

  const seen = new Set<string>()
  const dropDupeIds: string[] = []
  const deduped: MemoryEntry[] = []
  for (const e of live) {
    const key = `${String(e.category ?? "").toLowerCase()}|||${normalizeContent(e.content)}`
    if (seen.has(key)) {
      dropDupeIds.push(e.id)
      continue
    }
    seen.add(key)
    deduped.push(e)
  }

  const contradictions: DreamContradiction[] = []
  const bySubject = new Map<string, MemoryEntry[]>()
  for (const e of deduped) {
    const key = `${String(e.category ?? "").toLowerCase()}|||${subjectKey(normalizeContent(e.content))}`
    const group = bySubject.get(key) ?? []
    group.push(e)
    bySubject.set(key, group)
  }
  for (const group of bySubject.values()) {
    if (group.length < 2) continue
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i] as MemoryEntry
        const b = group[j] as MemoryEntry
        const na = normalizeContent(a.content)
        const nb = normalizeContent(b.content)
        if (na === nb) continue
        if (na.includes(nb) || nb.includes(na)) continue
        contradictions.push({
          aId: a.id,
          bId: b.id,
          reason: `same subject with different details (${a.id} vs ${b.id}) — resolve by hand, newest usually wins`,
        })
      }
    }
  }

  const relativeDateIds = deduped.filter((e) => RELATIVE_DATE_RE.test(e.content)).map((e) => e.id)

  let keep = [...deduped].sort((a, b) => entryTimestamp(a) - entryTimestamp(b))
  let capped = 0
  if (keep.length > DREAM_MAX_ENTRIES) {
    capped = keep.length - DREAM_MAX_ENTRIES
    keep = keep.slice(keep.length - DREAM_MAX_ENTRIES)
  }
  let bytesAfter = indexBytes(keep)
  while (keep.length > 1 && bytesAfter > DREAM_MAX_BYTES) {
    keep = keep.slice(1)
    capped++
    bytesAfter = indexBytes(keep)
  }

  return { keep, dropExpiredIds, dropDupeIds, contradictions, relativeDateIds, capped, bytesBefore, bytesAfter }
}

export interface DreamReport {
  scanned: number
  kept: number
  removedExpired: number
  removedDupes: number
  capped: number
  contradictions: number
  relativeDates: number
  bytesBefore: number
  bytesAfter: number
  changed: boolean
}

export function dreamStatusText(): string {
  const entries = loadMemory()
  const plan = planDreamConsolidation(entries)
  return (
    `Memory: ${entries.length} entries (~${plan.bytesBefore} bytes). ` +
    `Dream would drop ${plan.dropExpiredIds.length} expired, ` +
    `${plan.dropDupeIds.length} dupes, cap ${plan.capped}, ` +
    `flag ${plan.contradictions.length} contradictions and ` +
    `${plan.relativeDateIds.length} relative-date entries. ` +
    `Cap: ${DREAM_MAX_ENTRIES} entries / ~${DREAM_MAX_BYTES} bytes.`
  )
}

/** Run the deterministic pass: exact dupes + expired + cap. Never throws. */
export function runDreamConsolidation(): DreamReport {
  try {
    const entries = loadMemory()
    const plan = planDreamConsolidation(entries)
    const changed = plan.dropExpiredIds.length > 0 || plan.dropDupeIds.length > 0 || plan.capped > 0
    if (changed) saveMemory(plan.keep)
    return {
      scanned: entries.length,
      kept: plan.keep.length,
      removedExpired: plan.dropExpiredIds.length,
      removedDupes: plan.dropDupeIds.length,
      capped: plan.capped,
      contradictions: plan.contradictions.length,
      relativeDates: plan.relativeDateIds.length,
      bytesBefore: plan.bytesBefore,
      bytesAfter: plan.bytesAfter,
      changed,
    }
  } catch {
    return {
      scanned: 0,
      kept: 0,
      removedExpired: 0,
      removedDupes: 0,
      capped: 0,
      contradictions: 0,
      relativeDates: 0,
      bytesBefore: 0,
      bytesAfter: 0,
      changed: false,
    }
  }
}

export function reportText(r: DreamReport): string {
  const head = r.changed ? "Dream consolidation done." : "Dream consolidation: nothing to prune."
  return (
    `${head} Scanned ${r.scanned}, kept ${r.kept} ` +
    `(expired ${r.removedExpired}, dupes ${r.removedDupes}, capped ${r.capped}, ` +
    `~${r.bytesBefore}B -> ~${r.bytesAfter}B). ` +
    `Flagged ${r.contradictions} contradictions and ${r.relativeDates} relative-date entries for the model to resolve by hand.`
  )
}

export function createDreamTool(): Tool {
  return {
    definition: {
      timeoutMs: 60_000,
      name: "dream",
      description:
        "Deterministic memory consolidation: drop expired + exact-duplicate entries and enforce the 200-entry / ~25KB cap. Contradictions and relative dates are flagged, never auto-rewritten.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "consolidate | status",
            enum: ["consolidate", "status"],
          },
          focus: {
            type: "string",
            description: "Optional extra context (e.g. auth refactor). Recorded, not used by the deterministic pass.",
          },
        },
        required: ["action"],
      },
    },
    async execute(_id, args) {
      const action = String((args as { action?: unknown }).action ?? "")
      if (action === "status") return textResult(dreamStatusText())
      if (action === "consolidate") return textResult(reportText(runDreamConsolidation()))
      return textResult("dream: 'action' must be consolidate | status", /*isError*/ true)
    },
  }
}
