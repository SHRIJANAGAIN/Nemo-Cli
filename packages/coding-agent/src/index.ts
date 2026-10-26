/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { Agent, loadConfig, type AgentEvent, type NemoConfig } from "../../../apps/runtime/src/index.js"
import type { HarnessPlugin } from "../../harness/src/index.js"

export interface CodingTaskOptions {
  config?: Partial<NemoConfig>
  sessionFile?: string
  signal?: AbortSignal
  plugins?: HarnessPlugin[]
}

/**
 * High-level orchestrator for engineering tasks. Wires the core agent and the
 * default tool set, then runs a single task.
 */
export class CodingAgent {
  readonly agent: Agent

  constructor(options: CodingTaskOptions = {}) {
    const config = loadConfig(options.config ?? {})
    this.agent = new Agent({ config, sessionFile: options.sessionFile, plugins: options.plugins })
  }

  async run(prompt: string, emit?: (event: AgentEvent) => void, signal?: AbortSignal): Promise<AgentEvent[]> {
    const events: AgentEvent[] = []
    await this.agent.run(
      prompt,
      (event) => {
        events.push(event)
        emit?.(event)
      },
      signal,
    )
    return events
  }
}

export async function runCodingTask(prompt: string, options: CodingTaskOptions = {}): Promise<AgentEvent[]> {
  const coding = new CodingAgent(options)
  return coding.run(prompt, undefined, options.signal)
}
