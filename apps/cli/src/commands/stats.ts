/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { getDatabase, initDatabases, type DatabaseDatabase } from "../../../../packages/core/src/state_db.js"
import {
  accumulateCost,
  emptySessionCost,
  formatCostLine,
  formatUsd,
  type SessionCost,
} from "../../../../packages/core/src/cost_tracker.js"
import {
  analyzeTranscript,
  formatTranscriptStats,
  type TranscriptStats,
} from "../../../../packages/core/src/transcript_analytics.js"

export interface StatsInput {
  threads: Array<{ id: string; created_at: number; updated_at: number }>
  eventCounts: Record<string, number>
  violations: number
  /**
   * Token usage per model, for the cost line. Optional so the pure aggregator
   * still works when no usage has been recorded (and so existing callers and
   * tests keep passing unchanged).
   */
  usage?: Array<{ provider: string; model: string; inputTokens: number; outputTokens: number; cachedInputTokens?: number }>
}

export interface UsageStats {
  sessions: number
  events: number
  violations: number
  oldestActivity: number | null
  newestActivity: number | null
  /**
   * Aggregate spend, or null when nothing has been recorded yet.
   *
   * Optional rather than required so an existing caller constructing a literal
   * does not break — the cost line is additive.
   */
  cost?: SessionCost | null
}

/** Aggregate raw store rows into usage stats. Pure. */
export function collectStats(input: StatsInput): UsageStats {
  let events = 0
  for (const count of Object.values(input.eventCounts)) events += count
  let oldest: number | null = null
  let newest: number | null = null
  for (const thread of input.threads) {
    if (oldest === null || thread.created_at < oldest) oldest = thread.created_at
    if (newest === null || thread.updated_at > newest) newest = thread.updated_at
  }

  // Cost is only meaningful once something has been recorded. The key is OMITTED
  // rather than set to null, so a caller comparing the whole object with toEqual
  // is not broken by a field that did not exist before. "No usage yet" and
  // "free" are different facts and only one of them should be on screen.
  if (input.usage !== undefined && input.usage.length > 0) {
    const acc = emptySessionCost()
    for (const row of input.usage) {
      accumulateCost(acc, row.provider, row.model, {
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        ...(row.cachedInputTokens !== undefined ? { cachedInputTokens: row.cachedInputTokens } : {}),
      })
    }
    return {
      sessions: input.threads.length,
      events,
      violations: input.violations,
      oldestActivity: oldest,
      newestActivity: newest,
      cost: acc,
    }
  }

  return {
    sessions: input.threads.length,
    events,
    violations: input.violations,
    oldestActivity: oldest,
    newestActivity: newest,
  }
}

export function formatStats(stats: UsageStats): string {
  const lines = [
    "nemo Usage Stats",
    `sessions: ${stats.sessions}`,
    `events: ${stats.events}`,
    `violations: ${stats.violations}`,
    `oldest activity: ${stats.oldestActivity === null ? "none" : new Date(stats.oldestActivity).toISOString()}`,
    `newest activity: ${stats.newestActivity === null ? "none" : new Date(stats.newestActivity).toISOString()}`,
  ]
  // "partial — unpriced model" rides along so a total that silently omits an
  // unpriced model cannot be mistaken for a complete bill.
  if (stats.cost !== null && stats.cost !== undefined) {
    lines.push(`estimated cost: ${formatCostLine(stats.cost)}`)
  }
  return lines.join("\n")
}

function readStats(db: DatabaseDatabase): UsageStats {
  const threads = db.getAllThreads() as Array<{ id: string; created_at: number; updated_at: number }>
  const eventCounts: Record<string, number> = {}
  for (const thread of threads) {
    eventCounts[thread.id] = (db.getEvents(thread.id) as unknown[]).length
  }
  return collectStats({ threads, eventCounts, violations: (db.getViolations() as unknown[]).length })
}

/**
 * Analyse already-loaded transcript records.
 *
 * This takes RECORDS, not a session id, on purpose. Reading the file needs
 * `packages/session-backends`, and `apps/cli` may only import `packages/core`
 * and `packages/execpolicy` — the lint rule that enforces it explicitly forbids
 * grandfathering a new import to work around it. So the boundary is respected
 * by splitting the work: whoever can reach the filesystem (the TUI, the SDK, the
 * server, or `readTranscriptStats` in session-backends) supplies the records, and
 * this module does the pure analysis and formatting.
 */
export function transcriptStats(records: readonly unknown[]): TranscriptStats {
  return analyzeTranscript(records)
}

/** `nemo stats`: aggregate usage from the local state store. */
export function statsCommand(nemoHome?: string): string {
  const db = nemoHome ? initDatabases(nemoHome) : getDatabase()
  return formatStats(readStats(db))
}

/**
 * Per-session transcript report from already-loaded records.
 *
 * Separate from `statsCommand` rather than a section of it, because the two
 * answer different questions and need different inputs: aggregate spend comes
 * from the state database, per-turn detail comes from a transcript.
 */
export function transcriptStatsCommand(sessionId: string, records: readonly unknown[]): string {
  return `nemo Transcript Stats (${sessionId})\n${formatTranscriptStats(transcriptStats(records))}`
}

