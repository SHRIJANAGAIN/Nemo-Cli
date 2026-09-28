/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { AgentEvent } from "../../protocol/src/index.js"

/** A sink that receives agent lifecycle events for observability. */
export interface TelemetrySink {
  readonly id: string
  capture(event: AgentEvent): void
  flush(): void
}

export class ConsoleTelemetry implements TelemetrySink {
  readonly id = "console"
  private count = 0
  capture(event: AgentEvent): void {
    this.count++
    if (process.env.TRAYAMBAK_TELEMETRY === "debug") {
      process.stderr.write(`[telemetry] ${event.type}\n`)
    }
  }
  flush(): void {
    process.stderr.write(`[telemetry] captured ${this.count} events\n`)
  }
}

export class NullTelemetry implements TelemetrySink {
  readonly id = "null"
  capture(_event: AgentEvent): void {}
  flush(): void {}
}

export function createTelemetry(enabled = false): TelemetrySink {
  return enabled ? new ConsoleTelemetry() : new NullTelemetry()
}
