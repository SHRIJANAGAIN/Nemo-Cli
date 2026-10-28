/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import {
  getDatabase,
  initDatabases,
  stateFilePath,
  type DatabaseDatabase,
} from "../../../../packages/core/src/state_db.js"
import { usageOutput } from "../command-registry.js"

export type DbAction = "path" | "summary" | "threads" | "violations"

function readDb(nemoHome?: string): DatabaseDatabase {
  return nemoHome ? initDatabases(nemoHome) : getDatabase()
}

/** `nemo db path`: where the state file lives. */
export function dbPath(nemoHome?: string): string {
  return stateFilePath(nemoHome)
}

/** `nemo db threads`: one line per stored thread. */
export function dbThreads(nemoHome?: string): string {
  const threads = readDb(nemoHome).getAllThreads() as Array<{
    id: string
    updated_at: number
    metadata: unknown
  }>
  if (threads.length === 0) return "No threads"
  return (
    `Threads (${threads.length}):\n` +
    threads.map((t) => `  - ${t.id} | updated ${new Date(t.updated_at).toISOString()}`).join("\n")
  )
}

/** `nemo db violations`: sandbox/policy violations, newest first. */
export function dbViolations(nemoHome?: string): string {
  const violations = readDb(nemoHome).getViolations() as Array<{
    type: string
    path: string | null
    operation: string
    pid: number
    timestamp: number
  }>
  if (violations.length === 0) return "No violations"
  return (
    `Violations (${violations.length}):\n` +
    violations
      .map(
        (v) => `  - [${new Date(v.timestamp).toISOString()}] ${v.type} ${v.operation} ${v.path ?? "-"} (pid ${v.pid})`,
      )
      .join("\n")
  )
}

/** `nemo db <action>`: inspect the local state store. */
export function dbCommand(action: string, nemoHome?: string): string {
  const normalized = action.trim().toLowerCase() as DbAction | ""
  switch (normalized) {
    case "path":
      return dbPath(nemoHome)
    case "":
    case "summary": {
      const db = readDb(nemoHome)
      const threads = db.getAllThreads() as unknown[]
      const violations = db.getViolations() as unknown[]
      return [
        `State: ${dbPath(nemoHome)}`,
        `backend: ${db.backendKind()}`,
        `threads: ${threads.length}`,
        `violations: ${violations.length}`,
      ].join("\n")
    }
    case "threads":
      return dbThreads(nemoHome)
    case "violations":
      return dbViolations(nemoHome)
    default:
      return usageOutput(`Unknown db action: ${action}. Available: path|summary|threads|violations`)
  }
}
