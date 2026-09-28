export * as TrayambakSessionExportCommand from "./session-export"

import { sessionTranscript } from "../session/session-transcript.js"

export interface SessionExportOptions {
  readonly sessionId: string
  readonly format: "markdown" | "json" | "text"
  readonly includeSystem?: boolean
}

export function sessionExportCommand(options: SessionExportOptions): string {
  const messages = sessionTranscript.list({
    includeSystem: options.includeSystem ?? false,
  })

  if (messages.length === 0) {
    return "No messages to export"
  }

  const filtered = options.sessionId ? messages.filter((m: { id: string }) => m.id === options.sessionId) : messages

  if (filtered.length === 0) {
    return `No messages found for session ${options.sessionId}`
  }

  switch (options.format) {
    case "json":
      return JSON.stringify(
        filtered.map((m: { role: string; content: string }) => ({ role: m.role, content: m.content })),
        null,
        2,
      )
    case "text":
      return filtered.map((m: { role: string; content: string }) => `${m.role}: ${m.content}`).join("\n\n")
    case "markdown":
    default:
      return filtered
        .map((m: { role: string; content: string }) => `### ${m.role}\n${m.content}`)
        .join("\n\n")
        .replace(/^/m, "# Session Export\n\n")
  }
}
