/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { AgentEvent } from "../../protocol/src/index.js"
import { redactPayload } from "../../core/src/secrets.js"

/** A sink that receives agent lifecycle events for observability. */
export interface TelemetrySink {
  readonly id: string
  capture(event: AgentEvent): void
  flush(): void
}

/** Cap on the redacted debug detail written per event. Telemetry is
 *  stderr-only and line-oriented; a transcript-sized event must not flood it. */
const DEBUG_DETAIL_CAP = 2000

/**
 * Redacted, size-capped JSON detail for debug-mode stderr.
 *
 * Debug telemetry exists to observe what was captured, so the payload is
 * written — but through `redactPayload` first (secret-named keys → `"****"`,
 * embedded `sk-…`/`Bearer …` → `[REDACTED]`), and never truncated in a way
 * that would corrupt ordinary prose: the cap only applies after redaction and
 * only to the serialized line. Stays stderr-only — no network egress.
 */
function redactedDetail(event: AgentEvent): string {
  const fields = { ...(event as unknown as Record<string, unknown>) }
  delete fields.type
  try {
    const json = JSON.stringify(redactPayload(fields))
    if (json === undefined) return ""
    return ` ${json.length > DEBUG_DETAIL_CAP ? json.slice(0, DEBUG_DETAIL_CAP) + "…" : json}`
  } catch {
    // Never let a malformed/circular event break the emitting loop.
    return " [unserializable]"
  }
}

export class ConsoleTelemetry implements TelemetrySink {
  readonly id = "console"
  private count = 0
  capture(event: AgentEvent): void {
    this.count++
    if (isTelemetryDisabled()) return
    if (process.env.TRAYAMBAK_TELEMETRY === "debug") {
      process.stderr.write(`[telemetry] ${event.type}${redactedDetail(event)}\n`)
    }
  }
  flush(): void {
    // The kill-switch silences EVERY write, including this summary line:
    // env can flip to 0 after construction, and TRAYAMBAK_TELEMETRY=0 must
    // never be followed by output from the telemetry sink (#54).
    if (isTelemetryDisabled()) return
    process.stderr.write(`[telemetry] captured ${this.count} events\n`)
  }
}

export class NullTelemetry implements TelemetrySink {
  readonly id = "null"
  capture(_event: AgentEvent): void {}
  flush(): void {}
}

export function createTelemetry(enabled = false): TelemetrySink {
  if (isTelemetryDisabled()) return new NullTelemetry()
  return enabled ? new ConsoleTelemetry() : new NullTelemetry()
}

/**
 * Explicit kill-switch: TRAYAMBAK_TELEMETRY=0 (also false/off/no) forces
 * telemetry off even when a caller requests it. Unset/anything-else keeps
 * the caller's choice (default off).
 */
export function isTelemetryDisabled(): boolean {
  const raw = (process.env.TRAYAMBAK_TELEMETRY ?? "").trim().toLowerCase()
  return raw === "0" || raw === "false" || raw === "off" || raw === "no"
}
