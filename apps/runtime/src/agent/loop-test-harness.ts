/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Shared deterministic loop-test harness — the single builder every
 * agent-loop test should use instead of copy-pasting scripted providers.
 *
 * No network, no real processes, no ambient state: providers are scripted
 * by call order (the last reply repeats), tools are in-memory doubles, and
 * hook execution is injected. Each `runTestLoop` call counts provider
 * invocations so tests can assert `providerCalls` and catch unexpected
 * extra turns (a silent extra model call is a budget leak).
 */

import * as os from "node:os"
import { runAgentLoop, type RunConfig } from "./agent-loop.js"
import { Session } from "../session/session.js"
import { textResult, type Tool } from "../tools/types.js"
import type { HookShellExecutor } from "../tools/hook-exec.js"
import type { NemoConfig } from "../config.js"
import type { DeveloperModeEngine } from "../developer-mode/index.js"
import type { DenialTracker } from "../../../../packages/core/src/approval.js"
import type { ChatInput, Provider } from "../../../../packages/provider/src/index.js"
import type { AgentEvent, AgentMessage, AssistantMessage } from "../../../../packages/protocol/src/index.js"

export type ScriptedReply = (input: ChatInput) => AssistantMessage | Promise<AssistantMessage>

export interface ScriptedProvider {
  provider: Provider
  calls: () => number
}

/** Scripted provider: replies by call order, last reply repeats forever. */
export function makeScriptedProvider(replies: ScriptedReply[]): ScriptedProvider {
  let calls = 0
  const provider = {
    chat: async (input: ChatInput): Promise<AssistantMessage> => {
      const index = Math.min(calls, replies.length - 1)
      calls += 1
      return await replies[index]!(input)
    },
  } as unknown as Provider
  return { provider, calls: () => calls }
}

export function textReply(text: string): ScriptedReply {
  return () => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn" })
}

export function emptyReply(): ScriptedReply {
  return () => ({ role: "assistant", content: [], stopReason: "end_turn" })
}

export function toolReply(id: string, name: string, args: Record<string, unknown>): ScriptedReply {
  return () => ({
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    stopReason: "tool_use",
  })
}

export function failReply(message: string): ScriptedReply {
  return () => {
    throw new Error(message)
  }
}

export function testBaseConfig(overrides: Partial<NemoConfig> = {}): NemoConfig {
  return {
    maxTurns: 4,
    maxRetries: 0,
    retryDelayMs: 50,
    maxToolCalls: 10,
    maxParallelToolCalls: 4,
    timeoutMs: 5_000,
    cwd: os.tmpdir(),
    permissions: { mode: "default", rules: [], askByDefault: false },
    ...overrides,
  } as unknown as NemoConfig
}

export interface ProbeBehavior {
  throwMessage?: string
  delayMs?: number
}

/** In-memory tool double: records executed args, can throw or stall. */
export function probeTool(name: string, executed: string[], behavior: ProbeBehavior = {}): Tool {
  const delay = behavior.delayMs
  return {
    definition: {
      name,
      description: "test double",
      parameters: { type: "object", properties: {}, required: [] },
      timeoutMs: 10_000,
    },
    execute: async (_toolCallId, args) => {
      if (behavior.throwMessage !== undefined) {
        throw new Error(behavior.throwMessage)
      }
      executed.push(JSON.stringify(args))
      if (delay !== undefined) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delay)
        })
      }
      return textResult(`did:${name}`)
    },
  }
}

export interface TestLoopOptions {
  tools?: Tool[]
  onRequestPermission?: RunConfig["onRequestPermission"]
  signal?: AbortSignal
  developerMode?: DeveloperModeEngine
  hookExecutor?: HookShellExecutor
  session?: Session
  onEvent?: (event: AgentEvent) => void
  approvalTracker?: DenialTracker
  audit?: RunConfig["audit"]
}

export interface TestLoopResult {
  events: AgentEvent[]
  messages: AgentMessage[]
  session: Session
  providerCalls: () => number
}

export async function runTestLoop(
  prompt: string,
  config: NemoConfig,
  scripted: ScriptedProvider,
  opts: TestLoopOptions = {},
): Promise<TestLoopResult> {
  const session = opts.session ?? new Session()
  const events: AgentEvent[] = []
  const messages = await runAgentLoop(prompt, {
    provider: scripted.provider,
    tools: opts.tools ?? [],
    session,
    config,
    emit: async (event) => {
      opts.onEvent?.(event)
      events.push(event)
    },
    signal: opts.signal,
    developerMode: opts.developerMode,
    onRequestPermission: opts.onRequestPermission,
    hookExecutor: opts.hookExecutor,
    approvalTracker: opts.approvalTracker,
    audit: opts.audit,
  })
  return { events, messages, session, providerCalls: scripted.calls }
}

/**
 * Fail loudly when the provider was called an unexpected number of times.
 * An extra turn the test did not script is a budget leak — never let it
 * pass silently.
 */
export function assertProviderCalls(actual: number, expected: number, label = "providerCalls"): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected} provider call(s), got ${actual}`)
  }
}

export function eventsOfType<T extends AgentEvent["type"]>(
  events: AgentEvent[],
  type: T,
): Array<Extract<AgentEvent, { type: T }>> {
  return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)
}

/** Joined text of every tool-result message in the session. */
export function toolTexts(messages: AgentMessage[]): string[] {
  return messages
    .filter((m): m is Extract<AgentMessage, { role: "tool" }> => m.role === "tool")
    .map((m) => m.content.map((c) => (c.type === "text" ? c.text : "")).join(""))
}

/** Joined text of every assistant message in the session. */
export function assistantTexts(messages: AgentMessage[]): string[] {
  return messages
    .filter((m): m is AssistantMessage => m.role === "assistant")
    .map((m) => m.content.map((c) => (c.type === "text" ? c.text : "")).join(""))
}
