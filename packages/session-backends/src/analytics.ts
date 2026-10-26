/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Reading a transcript and turning it into statistics.
 *
 * The split exists because of an architecture boundary, not a preference:
 * `apps/cli` may only import `packages/core` and `packages/execpolicy`, so the
 * pure analysis lives in `core` and only this file — which needs to touch the
 * filesystem — lives here. The lint rule's own comment forbids adding a
 * grandfather entry to work around it, so the dependency had to be arranged
 * rather than excused.
 */

import { analyzeTranscript, formatTranscriptStats, type TranscriptStats } from "../../core/src/transcript_analytics.js"
import { readContext } from "./read.js"

/**
 * Analyse a stored transcript by session id.
 *
 * Returns null for a session that has no file at all. That is a different fact
 * from "a session that ran and stored nothing": the first means the id is wrong,
 * the second means there is genuinely nothing to report, and collapsing them
 * makes a typo look like an empty session.
 *
 * A corrupt file also yields null rather than throwing. Analytics is a reporting
 * path, and a `/stats` line that fails because one transcript was truncated by a
 * crash would make the command useless exactly when there is something to look
 * at.
 */
export function readTranscriptStats(sessionId: string): TranscriptStats | null {
  try {
    const result = readContext(sessionId)
    if (result.fileBytes === 0 && result.bytesRead === 0) return null
    return analyzeTranscript(result.records)
  } catch {
    return null
  }
}

/** `readTranscriptStats` plus terminal formatting, or null when unreadable. */
export function readTranscriptStatsText(sessionId: string): string | null {
  const stats = readTranscriptStats(sessionId)
  if (stats === null) return null
  return `nemo Transcript Stats (${sessionId})\n${formatTranscriptStats(stats)}`
}