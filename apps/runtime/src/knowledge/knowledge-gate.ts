/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

export type KnowledgeLevel = "known" | "stable" | "version_sensitive" | "unfamiliar" | "uncertain"

export interface KnowledgeCheckResult {
  level: KnowledgeLevel
  needsSearch: boolean
  reason: string
}

export function knowledgeCheck(description: string): KnowledgeCheckResult {
  const lower = description.toLowerCase()
  const versionSensitive = /\b(api|library|framework|sdk|cli|package|module)\b/.test(lower)
  const unfamiliar = /\b(unknown|unfamiliar|new|latest|recent|current|today|now)\b/.test(lower)

  if (unfamiliar) {
    return { level: "unfamiliar", needsSearch: true, reason: "mentions_unfamiliar_or_time_sensitive_terms" }
  }
  if (versionSensitive && /\b(version|latest|current|stable)\b/.test(lower)) {
    return { level: "version_sensitive", needsSearch: true, reason: "version_sensitive_api" }
  }
  return { level: "known", needsSearch: false, reason: "likely_known_or_repo_verifiable" }
}

export class SearchBudget {
  readonly limit: number
  private used = 0

  constructor(limit = 10000) {
    this.limit = limit
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used)
  }

  get usage(): number {
    return this.used
  }

  get tier(): "NORMAL" | "CAUTION" | "CONSERVE" | "STRICT" | "BLOCKED" {
    const ratio = this.used / this.limit
    if (ratio >= 1) return "BLOCKED"
    if (ratio >= 0.95) return "STRICT"
    if (ratio >= 0.85) return "CONSERVE"
    if (ratio >= 0.7) return "CAUTION"
    return "NORMAL"
  }

  canSpend(count: number): boolean {
    return this.used + count <= this.limit
  }

  spend(count: number): boolean {
    if (!this.canSpend(count)) return false
    this.used += count
    return true
  }
}
