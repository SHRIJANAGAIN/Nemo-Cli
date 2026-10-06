/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/** Required-args validation for tool calls (honest input guard). */

export function validateToolUse(name: string, args: Record<string, unknown>, required: string[]): string | null {
  for (const key of required) {
    const v = args[key]
    if (typeof v !== "string" || v.trim().length === 0) {
      return `tool '${name}' missing required '${key}'`
    }
  }
  return null
}

/**
 * Session IDs are single path segments by construction (UUIDs or
 * `timestamp-hex`). Anything else — `../` escapes, absolute paths,
 * separators — is rejected HERE so every fs sink that joins a session id
 * into a path (transcripts, conversation logs, archive) inherits the guard
 * from this one choke point. Lives in core so both packages/session-backends
 * and apps/cli share the exact same rule (never a drifting copy).
 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function assertSessionId(id: string): void {
  if (!SESSION_ID_RE.test(id)) {
    throw new Error(`invalid session id ${JSON.stringify(id)} (expected 1-128 chars of letters, digits, - _)`)
  }
}
