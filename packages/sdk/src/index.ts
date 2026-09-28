/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Trayambak TypeScript SDK (Codex sdk/typescript parity, minimal).
 * Usage: new TrayambakClient().startThread(prompt) / resumeThread(id)
 */

import { createTranscript, appendWire } from "../../session-backends/src/transcript.js"

export interface ThreadHandle {
  id: string
  events: unknown[]
}

async function loadAgent(): Promise<typeof import("../../../apps/runtime/src/index.js")> {
  return import("../../../apps/runtime/src/index.js")
}

export class TrayambakClient {
  async startThread(prompt: string, opts: { model?: string; workDir?: string } = {}): Promise<ThreadHandle> {
    const { Agent, loadConfig } = await loadAgent()
    const { id } = createTranscript(opts.workDir ?? process.cwd())
    const config = loadConfig({
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.workDir ? { cwd: opts.workDir } : {}),
    })
    const agent = new Agent({ config })
    const events: unknown[] = []
    appendWire(id, { type: "TurnBegin", user_input: prompt })
    await agent.run(prompt, (e) => {
      events.push(e)
    })
    return { id, events }
  }

  async resumeThread(id: string, prompt: string): Promise<ThreadHandle> {
    const { Agent, loadConfig } = await loadAgent()
    const config = loadConfig()
    const agent = new Agent({ config })
    const events: unknown[] = []
    appendWire(id, { type: "TurnBegin", user_input: prompt })
    await agent.run(prompt, (e) => {
      events.push(e)
    })
    return { id, events }
  }

  async exec(prompt: string): Promise<string> {
    const t = await this.startThread(prompt)
    return JSON.stringify({ threadId: t.id, events: t.events.length })
  }
}
