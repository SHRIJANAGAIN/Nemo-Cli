/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Vendored stand-in for `@claude-code/local-observability` (registry E404).
 * The fork's jediTermScrollFix wraps `logEvent(name, payload)` — an
 * internal telemetry sink nothing in this repo asserts on, so the stand-in
 * is a total no-op (secrets policy: no payload ever leaves the process).
 */

export const logEvent = (name, payload) => {
  void name
  void payload
}
