/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Budget accounting: R = 4k rollouts and P = 3k improvement stages.
 *
 * Base executions count toward each mode. A retry is a separate invocation
 * count but not a separate stage; selection and reflection are recorded
 * outside this ledger, exactly as the method defines them.
 *
 * Adapted from Harness² (Copyright 2026 Google LLC, Apache-2.0) — see
 * NOTICE.md in this directory.
 */

import type { HarnessLedgerSummary } from "./types.js"

/** The expected rollout count for one mode: k base + 2k candidates + k finals. */
export function expectedRollouts(k: number): number {
  return 4 * Math.trunc(k)
}

/** The expected improvement-stage count for one mode: k INV + k DOM + k compose. */
export function expectedStages(k: number): number {
  return 3 * Math.trunc(k)
}

/** One recorded spend. Retries fold into `attempts`, never into a second label. */
interface LedgerEntry {
  kind: "rollout" | "session"
  label: string
  usd: number
  attempts: number
  cached: boolean
}

/** Raised when a run's resource shape does not match the budget. */
export class HarnessBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HarnessBudgetError"
  }
}

/** One stage's session spend, as recorded after the stage settles. */
export interface LedgerSessionSpend {
  usd?: number
  attempts?: number
  cached?: boolean
}

export class HarnessLedger {
  readonly mode: string
  readonly taskId: string
  readonly k: number
  private readonly entries: LedgerEntry[] = []

  constructor(mode: string, taskId: string, k: number) {
    this.mode = mode
    this.taskId = taskId
    this.k = k
  }

  /** Record a rollout. The cost is the rollout's own reported spend. */
  rollout(label: string, usd = 0): void {
    this.entries.push({ kind: "rollout", label, usd, attempts: 1, cached: false })
  }

  /** Record an improvement stage once, after its retries have settled. */
  session(label: string, spend: LedgerSessionSpend = {}): void {
    this.entries.push({
      kind: "session",
      label,
      usd: Number.isFinite(spend.usd) ? Number(spend.usd) : 0,
      attempts: Math.max(0, Math.trunc(spend.attempts ?? 0)),
      cached: spend.cached === true,
    })
  }

  /** Rollouts recorded so far. */
  get rollouts(): number {
    return this.entries.filter((entry) => entry.kind === "rollout").length
  }

  /** Improvement stages recorded so far. */
  get sessions(): number {
    return this.entries.filter((entry) => entry.kind === "session").length
  }

  /** Labels recorded for a kind, in recording order. */
  labels(kind: "rollout" | "session"): string[] {
    return this.entries.filter((entry) => entry.kind === kind).map((entry) => entry.label)
  }

  /**
   * Assert the budget identity.
   *
   * Duplicates are checked BEFORE the counts: a duplicate label can satisfy
   * the counts while hiding a stage that never ran.
   */
  assertIdentity(): void {
    for (const kind of ["rollout", "session"] as const) {
      const seen = new Set<string>()
      for (const label of this.labels(kind)) {
        if (seen.has(label)) {
          throw new HarnessBudgetError(
            `duplicate ${kind} label ${label}: a stage overwrote another stage's run`,
          )
        }
        seen.add(label)
      }
    }
    const wantRollouts = expectedRollouts(this.k)
    if (this.rollouts !== wantRollouts) {
      throw new HarnessBudgetError(
        `expected ${wantRollouts} rollouts (4k), recorded ${this.rollouts}`,
      )
    }
    const wantStages = expectedStages(this.k)
    if (this.sessions !== wantStages) {
      throw new HarnessBudgetError(
        `expected ${wantStages} improvement stages (3k), recorded ${this.sessions}`,
      )
    }
  }

  /** The serialisable summary. */
  summary(): HarnessLedgerSummary {
    const sum = (kind: "rollout" | "session"): number =>
      this.entries.filter((entry) => entry.kind === kind).reduce((acc, entry) => acc + entry.usd, 0)
    const rolloutUsd = round(sum("rollout"))
    const sessionUsd = round(sum("session"))
    return {
      mode: this.mode,
      taskId: this.taskId,
      k: this.k,
      rollouts: this.rollouts,
      expectedRollouts: expectedRollouts(this.k),
      sessions: this.sessions,
      expectedSessions: expectedStages(this.k),
      sessionAttempts: this.entries
        .filter((entry) => entry.kind === "session")
        .reduce((acc, entry) => acc + entry.attempts, 0),
      usd: round(rolloutUsd + sessionUsd),
      rolloutUsd,
      sessionUsd,
    }
  }
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
