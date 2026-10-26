/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Deterministic eval harness.
 *
 * The old harness called the real agent with the ambient provider, so an eval
 * suite needed credentials, cost money per run, and produced a DIFFERENT result
 * on every run — a suite whose own flakiness had to be distinguished from a
 * regression. This one is built to be the opposite:
 *
 *  - The provider is a fixture driven by the task's turn script (no network, no
 *    keys, no billing).
 *  - The script is consumed by call order and the LAST entry repeats, so a loop
 *    that keeps calling tools terminates on the harness rather than hanging.
 *  - Tools are in-memory doubles that record their calls.
 *  - Every assertion is evaluated against a flattened transcript, so a task
 *    file stays DATA (loadable from JSON, reviewable in a diff) rather than a
 *    closure over test internals.
 */

import * as os from "node:os"
import { runAgentLoop } from "../../../apps/runtime/src/agent/agent-loop.js"
import { Session } from "../../../apps/runtime/src/session/session.js"
import { textResult, type Tool } from "../../../apps/runtime/src/tools/types.js"
import type { NemoConfig } from "../../../apps/runtime/src/config.js"
import type { ChatInput, Provider } from "../../../packages/provider/src/index.js"
import type {
  AgentEvent,
  AgentMessage,
  AssistantContentPart,
  AssistantMessage,
  TextPart,
} from "../../../packages/protocol/src/index.js"
import { evaluateAll } from "./assertions.js"
import {
  emptyTranscript,
  type EvalResult,
  type EvalSuiteResult,
  type EvalTask,
  type FixtureTool,
  type RunTranscript,
  type ScriptedTurn,
} from "./types.js"

/* ───────────────────────────── fixture provider ───────────────────────────── */

/**
 * Scripted provider: replies by call order, last entry repeats.
 *
 * The repeat matters. `runAgentLoop` runs until the model answers without tool
 * calls (or a turn/tool budget trips). A script that simply ran out would make
 * `chat` return undefined and the loop's error path would mask whatever the task
 * was actually testing, so the tail turn is served forever.
 */
export function makeScriptedProvider(turns: readonly ScriptedTurn[]): {
  provider: Provider
  calls: () => number
  requested: () => ChatInput[]
} {
  let calls = 0
  const requested: ChatInput[] = []
  const script = turns.length > 0 ? turns : [{ text: "" }]
  const provider = {
    id: "eval-fixture",
    chat: async (input: ChatInput): Promise<AssistantMessage> => {
      requested.push(input)
      const index = Math.min(calls, script.length - 1)
      calls += 1
      const turn = script[index]!
      const stopReason =
        turn.stopReason ?? (turn.toolCall ? "tool_use" : "end_turn")
      if (!turn.toolCall) {
        return {
          role: "assistant",
          content: [{ type: "text", text: turn.text ?? "" }],
          stopReason,
        }
      }
      return {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: `eval-${calls}`,
            name: turn.toolCall.name,
            arguments: turn.toolCall.args ?? {},
          },
        ],
        stopReason,
      }
    },
  } as Provider
  return { provider, calls: () => calls, requested: () => requested }
}

/* ─────────────────────────────── fixture tools ────────────────────────────── */

/** In-memory tool doubles. Each records the call and returns canned text. */
export function makeFixtureTools(specs: readonly FixtureTool[] | undefined): {
  tools: Tool[]
  calls: () => string[]
} {
  const seen: string[] = []
  const tools: Tool[] = (specs ?? []).map((spec) => ({
    definition: {
      name: spec.name,
      description: `eval fixture ${spec.name}`,
      parameters: { type: "object", properties: {}, required: [] },
      // Required by nemo/require-tool-timeout. These doubles resolve
      // synchronously, so the ceiling is a guard against a future fixture that
      // awaits something unbounded rather than an expected duration.
      timeoutMs: 1_000,
    },
    execute: async (): Promise<ReturnType<typeof textResult>> => {
      seen.push(spec.name)
      return textResult(spec.result ?? `${spec.name} ok`, spec.isError === true)
    },
  }))
  return { tools, calls: () => seen }
}

/* ──────────────────────────────── transcript ──────────────────────────────── */

/**
 * Join the prose out of a message's content parts.
 *
 * The parts are a discriminated union (text | thinking | toolCall), and only
 * two of the three carry `text`. `AssistantContentPart` is imported for that
 * reason rather than a loose `{ text?: string }` shape: the loose shape would
 * also have accepted a `ToolCallPart` with no `text`, silently contributing an
 * empty string where the caller meant "no text part at all". Thinking is
 * included on purpose — it is still model output an eval may want to assert on.
 */
function textOf(content: readonly AssistantContentPart[] | readonly TextPart[] | undefined): string {
  if (!Array.isArray(content)) return ""
  const out: string[] = []
  for (const part of content) {
    if (part.type === "text" || part.type === "thinking") out.push(part.text)
  }
  return out.join("")
}

/** Fold an event stream + session into the flat shape every assertion reads. */
export function buildTranscript(
  events: readonly AgentEvent[],
  messages: readonly AgentMessage[],
  providerCalls: number,
): RunTranscript {
  const t = emptyTranscript()
  t.providerCalls = providerCalls
  for (const event of events) {
    t.eventTypes.push(event.type)
    switch (event.type) {
      case "message_end": {
        // Only ASSISTANT messages are emitted as message_end. A tool result
        // reaches the session through turn_end's `toolResults` and is persisted
        // directly by the loop — it never gets its own message_end. Reading the
        // tool role here therefore found nothing, which is exactly how an
        // `erroredTools` assertion silently stopped matching.
        const m = event.message
        if (m.role === "assistant") {
          t.assistantTexts.push(textOf(m.content))
          t.turns += 1
        }
        break
      }
      case "tool_execution_start":
        t.toolCalls.push(event.toolName)
        break
      case "tool_execution_end": {
        // The only event carrying a tool result's error flag.
        if (event.isError) t.erroredTools.push(event.toolName)
        break
      }
      default:
        break
    }
  }
  for (const m of messages) {
    t.roles.push(m.role)
    if (m.role === "user") t.byRole.user += `${m.content}\n`
    else if (m.role === "assistant") t.byRole.assistant += `${textOf(m.content)}\n`
    else if (m.role === "tool") t.byRole.tool += `${textOf(m.content)}\n`
  }
  return t
}

/* ───────────────────────────────── config ────────────────────────────────── */

/**
 * Base config for a deterministic run.
 *
 * Every knob that could introduce wall-clock or environment sensitivity is
 * pinned: zero retries, a generous-but-finite tool timeout, and a temp cwd so a
 * task cannot touch the developer's real workspace. `permissions.askByDefault`
 * is false with full-access uiMode so no eval run can block on an approver that
 * does not exist in a headless harness.
 */
export function evalConfig(overrides: Partial<NemoConfig> = {}): NemoConfig {
  return {
    maxTurns: 6,
    maxRetries: 0,
    retryDelayMs: 0,
    maxToolCalls: 12,
    maxParallelToolCalls: 4,
    timeoutMs: 5_000,
    cwd: os.tmpdir(),
    permissions: { mode: "default", rules: [], askByDefault: false, uiMode: "full-access" },
    ...overrides,
  } as NemoConfig
}

/* ────────────────────────────────── runner ───────────────────────────────── */

export interface RunOptions {
  config?: Partial<NemoConfig>
  signal?: AbortSignal
  now?: () => number
}

/** Run one task's fixture through the real loop. Never throws. */
export async function runTask(
  task: EvalTask,
  opts: RunOptions = {},
): Promise<{ transcript: RunTranscript; errors: string[]; durationMs: number }> {
  const errors: string[] = []
  const clock = opts.now ?? ((): number => Date.now())
  const startedAt = clock()
  const { provider, calls } = makeScriptedProvider(task.turns ?? [])
  const { tools } = makeFixtureTools(task.tools)
  const session = new Session()
  const events: AgentEvent[] = []

  try {
    await runAgentLoop(task.prompt, {
      provider,
      tools,
      session,
      config: evalConfig(opts.config),
      emit: async (event: AgentEvent): Promise<void> => {
        events.push(event)
      },
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  } catch (error) {
    errors.push(`run threw: ${error instanceof Error ? error.message : String(error)}`)
  }

  const transcript = buildTranscript(events, session.messages, calls())
  const sawErrorTurn = events.some(
    (e) => e.type === "message_end" && e.message.role === "assistant" && e.message.stopReason === "error",
  )
  if (transcript.error === undefined && sawErrorTurn) {
    transcript.error = "provider error turn"
    errors.push("provider reported an error turn")
  }
  return { transcript, errors, durationMs: Math.max(0, clock() - startedAt) }
}

/** Run one task and evaluate its assertions. */
export async function evaluateTask(task: EvalTask, opts: RunOptions = {}): Promise<EvalResult> {
  if (task.skip) {
    return {
      name: task.name,
      ...(task.group ? { group: task.group } : {}),
      status: "skipped",
      outcomes: [],
      skipReason: task.skip,
      durationMs: 0,
      errors: [],
    }
  }
  if (!Array.isArray(task.assertions) || task.assertions.length === 0) {
    return {
      name: task.name,
      ...(task.group ? { group: task.group } : {}),
      status: "failed",
      outcomes: [],
      durationMs: 0,
      errors: ["task declares no assertions — a task that cannot fail proves nothing"],
    }
  }
  const { transcript, errors, durationMs } = await runTask(task, opts)
  const outcomes = evaluateAll(task.assertions, transcript)
  const failed = outcomes.filter((o) => !o.passed)
  return {
    name: task.name,
    ...(task.group ? { group: task.group } : {}),
    status: failed.length === 0 && errors.length === 0 ? "passed" : "failed",
    outcomes,
    durationMs,
    errors,
  }
}

/** Run a whole suite in declaration order. Tasks never run concurrently: the
 *  loop shares module-level budget state, so parallel tasks would cross-charge
 *  each other's usage. */
export async function runSuite(tasks: readonly EvalTask[], opts: RunOptions = {}): Promise<EvalSuiteResult> {
  const results: EvalResult[] = []
  const clock = opts.now ?? ((): number => Date.now())
  const startedAt = clock()
  for (const task of tasks) {
    results.push(await evaluateTask(task, opts))
  }
  return {
    results,
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    durationMs: Math.max(0, clock() - startedAt),
  }
}