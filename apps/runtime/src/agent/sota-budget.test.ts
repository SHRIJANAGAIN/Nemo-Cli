/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * SOTA mode's budget accounting.
 *
 * A complex prompt is answered by the SOTA reasoning engine INSTEAD of
 * `runAgentLoop`, so the loop's usage recording never runs for that turn. The
 * engine calls the main (paid) provider once per candidate, re-solve, and CoT
 * node — so before this was charged, the most expensive path in the agent cost
 * a user who set a token cap exactly nothing against it.
 *
 * Zero network: a scripted mock Provider answers every chat call.
 */

import { afterEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Agent } from "./agent.js"
import type { NemoConfig } from "../config.js"
import { getRolloutBudget } from "../../../../packages/core/src/rollout_budget.js"
import { resetBudget } from "../../../../packages/core/src/token_budget.js"
import type { AssistantMessage } from "../../../../packages/protocol/src/index.js"
import type { ChatInput, Provider } from "../../../../packages/provider/src/index.js"

type MockProvider = Provider & { readonly calls: ChatInput[] }

const tempDirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sota-budget-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  resetBudget()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) break
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
})

function makeConfig(cwd: string): NemoConfig {
  return {
    cwd,
    provider: "custom",
    baseUrl: "http://127.0.0.1:9",
    model: "mock-model",
    temperature: 0,
    topP: 1,
    maxTokens: 512,
    timeoutMs: 30_000,
    maxTurns: 8,
    maxRetries: 0,
    retryDelayMs: 10,
    maxToolCalls: 10,
    maxParallelToolCalls: 4,
    maxDistinctToolCalls: 100,
    toolCallRate: 0,
    nativeTools: true,
    skillsDir: path.join(cwd, "no-skills"),
    permissions: { mode: "default", rules: [], askByDefault: false },
    toolsets: { defaults: ["core", "agentic", "ops", "tasks", "mcp", "skills"], disabled: [], platform: {} },
  } as unknown as NemoConfig
}

const textMsg = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "end_turn",
})

function scriptedProvider(respond: (callIndex: number) => AssistantMessage): MockProvider {
  const calls: ChatInput[] = []
  return {
    id: "mock",
    calls,
    async chat(): Promise<AssistantMessage> {
      const index = calls.length
      calls.push({} as ChatInput)
      return respond(index)
    },
  } as MockProvider
}

describe("SOTA mode charges the rollout budget", () => {
  it("records usage for provider calls made outside the turn loop", async () => {
    const provider = scriptedProvider(() => textMsg("function add(a, b) { return a + b }"))
    const agent = await Agent.create({ config: makeConfig(tempDir()), provider })

    // configure() zeroes the accumulator, so this doubles as the reset.
    getRolloutBudget().configure({ samplingTokenWeight: 1, maxBudget: 1_000_000, reminderInterval: 1_000 })
    expect(getRolloutBudget().getUsed()).toBe(0)

    agent.setSotaMode(true)
    expect(agent.isSotaEnabled()).toBe(true)
    // "implement" trips the SOTA branch's complexity test, so the turn is
    // answered by the reasoning engine rather than runAgentLoop.
    await agent.run("implement a function that adds two numbers", () => {})

    // The engine really did talk to the provider...
    expect(provider.calls.length).toBeGreaterThan(0)
    // ...and every one of those calls was paid for. Before the fix this stayed
    // at 0: a token cap could not see a single SOTA token.
    expect(getRolloutBudget().getUsed()).toBeGreaterThan(0)
  })
})
