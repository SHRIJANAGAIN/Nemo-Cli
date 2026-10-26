/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

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

/**
 * True when `p` addresses a file on a UNC/remote share rather than the local
 * filesystem. Lives here (not in apps/runtime) so every fs sink —
 * config paths, session files, transcript roots — shares ONE rule instead
 * of a drifting copy.
 *
 * Paths arriving over the network are rejected by callers BEFORE any fs
 * probe: existsSync/readFileSync against an attacker-chosen host would
 * authenticate to it (NTLM hash leak) and stall for seconds, and the
 * atomic-rename writes are not atomic across SMB. Recognised forms:
 *   - `\\host\share\file`      classic UNC
 *   - `//host/share/file`      same thing, forward slashes
 *   - `\\?\UNC\host\share`    extended-length UNC
 * Deliberately NOT remote, and therefore NOT rejected:
 *   - `C:\local\file`          local drive
 *   - `\\?\C:\local`           extended-length LOCAL path — still local
 *   - `\\.\PhysicalDrive0`     Win32 device namespace, not a share
 *   - relative paths          not remote by definition
 */
export function isRemoteUncPath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0) return false
  // Win32 device namespace (\\.\PhysicalDrive0, \\.\PIPE\x) is never a share.
  if (/^\\\\\.\\/.test(p) || /^\/\/\.\//.test(p)) return false
  // Extended-length UNC: \\?\UNC\host\share
  if (/^\\\\\?\\UNC\\/i.test(p)) return true
  // Extended-length LOCAL path (\\?\C:\local) is still local.
  if (/^\\\\\?\\[a-z]:\\/i.test(p) || /^\/\/\?\/[a-z]:\//i.test(p)) return false
  // Classic UNC in either separator style: \\host\share or //host/share
  return /^\\\\[^\\]/.test(p) || /^\/\/[^/]/.test(p)
}
