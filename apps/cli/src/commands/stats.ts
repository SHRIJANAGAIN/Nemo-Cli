/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { getDatabase, initDatabases, type DatabaseDatabase } from "../../../../packages/core/src/state_db.js"

export interface StatsInput {
  threads: Array<{ id: string; created_at: number; updated_at: number }>
  eventCounts: Record<string, number>
  violations: number
}

export interface UsageStats {
  sessions: number
  events: number
  violations: number
  oldestActivity: number | null
  newestActivity: number | null
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
    "trayambak Usage Stats",
    `sessions: ${stats.sessions}`,
    `events: ${stats.events}`,
    `violations: ${stats.violations}`,
    `oldest activity: ${stats.oldestActivity === null ? "none" : new Date(stats.oldestActivity).toISOString()}`,
    `newest activity: ${stats.newestActivity === null ? "none" : new Date(stats.newestActivity).toISOString()}`,
  ]
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

/** `trayambak stats`: aggregate usage from the local state store. */
export function statsCommand(codexHome?: string): string {
  const db = codexHome ? initDatabases(codexHome) : getDatabase()
  return formatStats(readStats(db))
}
