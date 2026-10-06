/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import {
  getDatabase,
  initDatabases,
  stateFilePath,
  type DatabaseDatabase,
} from "../../../../packages/core/src/state_db.js"
import { usageOutput } from "../command-registry.js"

export type DbAction = "path" | "summary" | "threads" | "violations"

function readDb(codexHome?: string): DatabaseDatabase {
  return codexHome ? initDatabases(codexHome) : getDatabase()
}

/** `trayambak db path`: where the state file lives. */
export function dbPath(codexHome?: string): string {
  return stateFilePath(codexHome)
}

/** `trayambak db threads`: one line per stored thread. */
export function dbThreads(codexHome?: string): string {
  const threads = readDb(codexHome).getAllThreads() as Array<{
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

/** `trayambak db violations`: sandbox/policy violations, newest first. */
export function dbViolations(codexHome?: string): string {
  const violations = readDb(codexHome).getViolations() as Array<{
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

/** `trayambak db <action>`: inspect the local state store. */
export function dbCommand(action: string, codexHome?: string): string {
  const normalized = action.trim().toLowerCase() as DbAction | ""
  switch (normalized) {
    case "path":
      return dbPath(codexHome)
    case "":
    case "summary": {
      const db = readDb(codexHome)
      const threads = db.getAllThreads() as unknown[]
      const violations = db.getViolations() as unknown[]
      return [
        `State: ${dbPath(codexHome)}`,
        `backend: ${db.backendKind()}`,
        `threads: ${threads.length}`,
        `violations: ${violations.length}`,
      ].join("\n")
    }
    case "threads":
      return dbThreads(codexHome)
    case "violations":
      return dbViolations(codexHome)
    default:
      return usageOutput(`Unknown db action: ${action}. Available: path|summary|threads|violations`)
  }
}
