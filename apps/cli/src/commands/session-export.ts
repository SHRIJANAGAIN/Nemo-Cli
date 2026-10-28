export * as NemoSessionExportCommand from "./session-export"

import { assertSessionId } from "../../../../packages/core/src/validate.js"
import { loadConversation } from "../../../../nemo/9-session/session.js"
import { failOutput, usageOutput } from "../command-registry.js"

export interface SessionExportOptions {
  readonly sessionId: string
  readonly format: "markdown" | "json" | "text"
  readonly includeSystem?: boolean
}

/**
 * Exportable rows are the conversation itself: user/assistant, plus system
 * only when asked. Tool rows carry raw args JSON — never conversation text.
 */
interface ExportRow {
  readonly role: string
  readonly content: string
}

/**
 * A session id names a PERSISTED conversation (`nemo/8-conversations/<id>/log.jsonl`)
 * — the same store resume/restore reads. It is user input, so it crosses the
 * shared `assertSessionId` choke point BEFORE any path join (`../` escapes are
 * usage errors, exit 2, never a silent "not found"). Returns an error string
 * (already fail/usage-stamped) or the rows to export.
 */
function persistedRows(sessionId: string, includeSystem: boolean): ExportRow[] | string {
  try {
    assertSessionId(sessionId)
  } catch {
    return usageOutput(`invalid session id: ${sessionId}`)
  }
  const rows: ExportRow[] = loadConversation(sessionId)
    .filter((m) => m.role === "user" || m.role === "assistant" || (includeSystem && m.role === "system"))
    .map((m) => ({ role: m.role, content: m.content }))
  if (rows.length === 0) return failOutput(`No messages found for session ${sessionId}`)
  return rows
}

export function sessionExportCommand(options: SessionExportOptions): string {
  const includeSystem = options.includeSystem ?? false

  let rows: ExportRow[]
  if (options.sessionId) {
    // With an id, export that session's PERSISTED log. The old behavior
    // filtered this process's in-memory transcript by MESSAGE id, which
    // matched nothing in a fresh CLI process — `nemo export <id>` could
    // never succeed.
    const loaded = persistedRows(options.sessionId, includeSystem)
    if (typeof loaded === "string") return loaded
    rows = loaded
  } else {
    // No id: the deleted in-memory sessionTranscript used to serve this
    // branch, but nothing in production ever wrote to it (its only .add()
    // call lived in the test below), so it always fell through to "No
    // messages to export" below. Keep that exact observable behavior with an
    // empty row set instead of resurrecting the deleted store.
    rows = []
  }

  if (rows.length === 0) {
    return failOutput("No messages to export")
  }

  switch (options.format) {
    case "json":
      return JSON.stringify(
        rows.map((m) => ({ role: m.role, content: m.content })),
        null,
        2,
      )
    case "text":
      return rows.map((m) => `${m.role}: ${m.content}`).join("\n\n")
    case "markdown":
    default:
      return rows
        .map((m) => `### ${m.role}\n${m.content}`)
        .join("\n\n")
        .replace(/^/m, "# Session Export\n\n")
  }
}
