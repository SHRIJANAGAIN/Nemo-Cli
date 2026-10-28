/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * GitHub job ledger — every bot run leaves a row.
 *
 * Server logs rotate and lose history; this append-only JSONL file keeps
 * the durable record: which repo/issue ran, when, what it was asked, how
 * many messages it took, and what it answered (head only — full bodies
 * stay in the thread + server log, not here). Rotation trims past ~2MB to
 * the newest 2000 lines so the 1GB VPS never chokes on history.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface JobRecord {
  ts: string
  repo: string
  issue: number
  task: string
  messages: number
  replyHead: string
  error?: string
}

export function defaultJobLedgerPath(): string {
  return process.env.GITHUB_JOBS_PATH ?? "./data/github-jobs.jsonl"
}

function entryToLine(record: JobRecord): string {
  return `${JSON.stringify({
    ts: record.ts,
    repo: record.repo,
    issue: record.issue,
    task: record.task.slice(0, 200),
    messages: record.messages,
    replyHead: record.replyHead.slice(0, 500),
    ...(record.error ? { error: record.error.slice(0, 300) } : {}),
  })}\n`
}

/** Append one job row. Never throws — telemetry must not break replies. */
export function recordJob(record: Omit<JobRecord, "ts">, file?: string): void {
  try {
    const path = file ?? defaultJobLedgerPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, entryToLine({ ...record, ts: new Date().toISOString() }), {
      encoding: "utf8",
      flag: "a",
      mode: 0o600,
    })
    try {
      chmodSync(path, 0o600)
    } catch {
      /* non-POSIX */
    }
    if (statSync(path).size > 2_097_152) {
      const lines = readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
      writeFileSync(path, `${lines.slice(-2000).join("\n")}\n`, "utf8")
    }
  } catch {
    // Telemetry must never break the job.
  }
}

/** Newest-first tail (cap 200) for operator inspection. */
export function readJobTail(n: number, file?: string): JobRecord[] {
  const count = Math.min(Math.max(Math.floor(n), 1), 200)
  try {
    const path = file ?? defaultJobLedgerPath()
    if (!existsSync(path)) return []
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
    const out: JobRecord[] = []
    for (const line of lines.slice(-count).reverse()) {
      try {
        out.push(JSON.parse(line) as JobRecord)
      } catch {
        // Skip torn lines.
      }
    }
    return out
  } catch {
    return []
  }
}
