/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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
