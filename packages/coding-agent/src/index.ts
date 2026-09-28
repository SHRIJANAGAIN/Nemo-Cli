/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { Agent, loadConfig, type AgentEvent, type TrayambakConfig } from "../../../apps/runtime/src/index.js"
import { createTelemetry, type TelemetrySink } from "../../telemetry/src/index.js"
import type { HarnessPlugin } from "../../harness/src/index.js"

export interface CodingTaskOptions {
  config?: Partial<TrayambakConfig>
  sessionFile?: string
  telemetry?: boolean
  signal?: AbortSignal
  plugins?: HarnessPlugin[]
}

/**
 * High-level orchestrator for engineering tasks. Wires the core agent, the
 * default tool set, and an optional telemetry sink, then runs a single task.
 */
export class CodingAgent {
  readonly agent: Agent
  private readonly telemetry: TelemetrySink

  constructor(options: CodingTaskOptions = {}) {
    const config = loadConfig(options.config ?? {})
    this.telemetry = createTelemetry(options.telemetry ?? false)
    this.agent = new Agent({ config, sessionFile: options.sessionFile, plugins: options.plugins })
  }

  async run(prompt: string, emit?: (event: AgentEvent) => void, signal?: AbortSignal): Promise<AgentEvent[]> {
    const events: AgentEvent[] = []
    try {
      await this.agent.run(
        prompt,
        (event) => {
          this.telemetry.capture(event)
          events.push(event)
          emit?.(event)
        },
        signal,
      )
    } finally {
      this.telemetry.flush()
    }
    return events
  }
}

export async function runCodingTask(prompt: string, options: CodingTaskOptions = {}): Promise<AgentEvent[]> {
  const coding = new CodingAgent(options)
  return coding.run(prompt, undefined, options.signal)
}
