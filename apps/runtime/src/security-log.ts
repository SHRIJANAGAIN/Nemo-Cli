/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Local security trail — append-only JSONL for events that must survive
 * for forensics, not for the transcript:
 *
 *  - `prompt_exfil_attempt`: someone passed `--dump-system-prompt` (or any
 *    future prompt-extraction probe). The system prompt is never printed,
 *    logged, or persisted — the attempt itself is what gets stored.
 *  - `pentest_run`: every pentest tool execution AND refusal (who ran what
 *    against which target, exit code, findings count). Defensive tooling
 *    without an audit trail is indistinguishable from abuse.
 *
 * Best-effort by design: this NEVER throws, so a read-only home, a full
 * disk, or a broken env degrades to a missing line — never a broken
 * install, a dead tool, or a crashed CLI. Every value passes secret
 * redaction first (values, then the serialized line), so key material lands
 * as `"****"` / `[REDACTED]`, never raw.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { redactEmbeddedSecrets, redactLogValue } from "../../../packages/core/src/secrets.js"

export type SecurityEventType = "prompt_exfil_attempt" | "pentest_run"

export interface SecurityEvent {
  type: SecurityEventType
  [key: string]: unknown
}

/** Override for tests (`TRAYAMBAK_SECURITY_LOG` points at tmp). */
export function securityLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TRAYAMBAK_SECURITY_LOG
  if (typeof override === "string" && override.trim().length > 0) return override
  return join(homedir(), ".trayambak", "security.log")
}

/** Append one event. Total: never throws, never returns anything useful. */
export function logSecurityEvent(event: SecurityEvent, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const file = securityLogPath(env)
    mkdirSync(dirname(file), { recursive: true })
    const record = redactLogValue({ at: new Date().toISOString(), ...event })
    const line = redactEmbeddedSecrets(JSON.stringify(record))
    appendFileSync(file, `${line}\n`, { mode: 0o600 })
  } catch {
    // The security trail must never break its caller.
  }
}
