/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Agent-loop guard coverage — every fail-closed path in agent-loop.ts that
 * had no test: provider retry/backoff (incl. retryAfter + mid-retry abort),
 * bounded transient restarts, doom-loop detection, tool-call and
 * distinct-tool limits, permission deny/ask gates, the hook ask gate,
 * unknown tool / thrown error / timeout handling, streaming placeholders,
 * text-fence tool-call extraction, developer-mode verification, context
 * overflow → force compaction, and pre-aborted runs.
 *
 * Deterministic by construction: providers are scripted, tools are
 * in-memory doubles, hooks use an injected shell stub — no network, no
 * real processes (AGENTS.md: harness tests for tool/denial/no-tool turns).
 */

import { describe, expect, it } from "vitest"
import * as os from "node:os"
import { runAgentLoop, type RunConfig } from "./agent-loop.js"
import { Session } from "../session/session.js"
import { textResult, type Tool } from "../tools/types.js"
import type { HookShellExecutor } from "../tools/hook-exec.js"
import type { TrayambakConfig } from "../config.js"
import type { DeveloperModeEngine } from "../developer-mode/index.js"
import type { ChatInput, Provider } from "../../../../packages/provider/src/index.js"
import type { AgentEvent, AgentMessage, AssistantMessage } from "../../../../packages/protocol/src/index.js"

/* ───────────────────────────── harness ───────────────────────────── */

type Reply = (input: ChatInput) => AssistantMessage | Promise<AssistantMessage>

/** Scripted provider: replies by call order, last reply repeats forever. */
function makeProvider(replies: Reply[]): { provider: Provider; calls: () => number } {
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

function baseConfig(overrides: Partial<TrayambakConfig> = {}): TrayambakConfig {
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
  } as unknown as TrayambakConfig
}

interface LoopOptions {
  tools?: Tool[]
  onRequestPermission?: RunConfig["onRequestPermission"]
  signal?: AbortSignal
  developerMode?: DeveloperModeEngine
  hookExecutor?: HookShellExecutor
  session?: Session
  /** Test sink; a throw here simulates a broken event consumer. */
  onEvent?: (event: AgentEvent) => void
}

async function runLoop(
  config: TrayambakConfig,
  provider: Provider,
  opts: LoopOptions = {},
): Promise<{ events: AgentEvent[]; messages: AgentMessage[]; session: Session }> {
  const session = opts.session ?? new Session()
  const events: AgentEvent[] = []
  const messages = await runAgentLoop("go", {
    provider,
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
  })
  return { events, messages, session }
}

function eventsOfType<T extends AgentEvent["type"]>(
  events: AgentEvent[],
  type: T,
): Array<Extract<AgentEvent, { type: T }>> {
  return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)
}

/** Text of every tool result message (joined content parts). */
function toolTexts(messages: AgentMessage[]): string[] {
  return messages
    .filter((m): m is Extract<AgentMessage, { role: "tool" }> => m.role === "tool")
    .map((m) => m.content.map((c) => (c.type === "text" ? c.text : "")).join(""))
}

function assistantTexts(messages: AgentMessage[]): string[] {
  return messages
    .filter((m): m is AssistantMessage => m.role === "assistant")
    .map((m) => m.content.map((c) => (c.type === "text" ? c.text : "")).join(""))
}

/** Error rows emitted by streamAssistant (they never reach the session). */
function streamedErrors(events: AgentEvent[]): string[] {
  return eventsOfType(events, "message_end")
    .filter((e) => e.message.role === "assistant" && e.message.stopReason === "error")
    .map((e) => {
      const m = e.message
      if (m.role !== "assistant") return ""
      return m.content.map((c) => (c.type === "text" ? c.text : "")).join("")
    })
}

/* ─────────────────────── scripted replies ─────────────────────── */

function textReply(text: string): Reply {
  return () => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn" })
}

function emptyReply(): Reply {
  return () => ({ role: "assistant", content: [], stopReason: "end_turn" })
}

function toolReply(id: string, name: string, args: Record<string, unknown>): Reply {
  return () => ({
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    stopReason: "tool_use",
  })
}

function failReply(message: string): Reply {
  return () => {
    throw new Error(message)
  }
}

/** Drives onText / onThinking / onToolCallDelta before returning a final text turn. */
const streamingReply: Reply = (input) => {
  input.callbacks?.onText?.("Hel")
  input.callbacks?.onThinking?.("deep work")
  input.callbacks?.onToolCallDelta?.("search", '{"q":')
  return { role: "assistant", content: [{ type: "text", text: "Hello world" }], stopReason: "end_turn" }
}

interface ProbeBehavior {
  throwMessage?: string
  delayMs?: number
}

/** In-memory tool double: records executed args, can throw or stall. */
function probeTool(name: string, executed: string[], behavior: ProbeBehavior = {}): Tool {
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

function sequentialTool(order: string[]): Tool {
  return {
    definition: {
      name: "seq",
      description: "sequential test double",
      parameters: { type: "object", properties: {}, required: [] },
      timeoutMs: 10_000,
      executionMode: "sequential",
    },
    execute: async (_toolCallId, args) => {
      const label = String(args.label)
      order.push(`start:${label}`)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 15)
      })
      order.push(`end:${label}`)
      return textResult(`did:${label}`)
    },
  }
}

function developerModeWith(opts: {
  stepByStep: boolean
  observeMistakes: boolean
  mistakes?: unknown[]
}): DeveloperModeEngine {
  return {
    isEnabled: () => true,
    config: { stepByStep: opts.stepByStep, observeMistakes: opts.observeMistakes },
    recordMistake: (record: unknown) => {
      opts.mistakes?.push(record)
    },
  } as unknown as DeveloperModeEngine
}

/* ─────────────── provider retry / streaming ─────────────── */

describe("provider retry and streaming", () => {
  it("retries a 429 with backoff and succeeds on the next attempt", async () => {
    const { provider, calls } = makeProvider([failReply("429 Too Many Requests"), textReply("recovered after retry")])
    const { events, messages } = await runLoop(baseConfig({ maxRetries: 3 }), provider)

    expect(calls()).toBe(2)
    expect(streamedErrors(events)).toHaveLength(0)
    expect(assistantTexts(messages).join("\n")).toContain("recovered after retry")
  })

  it("honors a retryAfter hint when backing off from a rate limit", async () => {
    const rateLimited: Reply = () => {
      const err = new Error("429 rate limited") as Error & { retryAfter?: string }
      err.retryAfter = "1"
      throw err
    }
    const { provider, calls } = makeProvider([rateLimited, textReply("through")])
    const started = Date.now()
    const { messages } = await runLoop(baseConfig({ maxRetries: 3 }), provider)

    expect(calls()).toBe(2)
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(assistantTexts(messages).join("\n")).toContain("through")
  })

  it("surfaces an abort that lands mid-retry instead of hanging", async () => {
    const controller = new AbortController()
    const flaky: Reply = () => {
      setTimeout(() => {
        controller.abort()
      }, 5)
      throw new Error("read ECONNRESET")
    }
    const { provider } = makeProvider([flaky, textReply("never reached")])
    const { events } = await runLoop(baseConfig({ maxRetries: 3 }), provider, {
      signal: controller.signal,
    })

    expect(streamedErrors(events).join("\n")).toContain("Operation aborted during provider retry.")
    expect(eventsOfType(events, "agent_end")).toHaveLength(1)
  })

  it("fails loudly after bounded transient restarts (no eternal spinner)", async () => {
    const { provider, calls } = makeProvider([failReply("read ECONNRESET")])
    const { events } = await runLoop(baseConfig(), provider)

    expect(calls()).toBe(3) // initial attempt + 2 bounded restarts
    const errors = streamedErrors(events)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("ECONNRESET")
    expect(eventsOfType(events, "agent_end")).toHaveLength(1)
  })

  it("points at the key fix when the provider rejects credentials", async () => {
    const { provider } = makeProvider([failReply("401 invalid api key")])
    const { events } = await runLoop(baseConfig(), provider)

    const errors = streamedErrors(events)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("401 invalid api key")
    expect(errors[0]).toContain("Key rejected — run `/provider key`")
  })

  it("recovers from an empty assistant response instead of ending silently", async () => {
    const { provider, calls } = makeProvider([emptyReply(), textReply("recovered")])
    const { messages } = await runLoop(baseConfig(), provider)

    expect(calls()).toBe(2)
    expect(assistantTexts(messages).join("\n")).toContain("recovered")
  })

  it("falls back to a retry hint when the model stays empty", async () => {
    const { provider, calls } = makeProvider([emptyReply()])
    const { messages } = await runLoop(baseConfig(), provider)

    expect(calls()).toBe(4) // initial + 3 bounded empty recoveries
    expect(assistantTexts(messages).join("\n")).toContain("The model returned no content. Please try again.")
  })

  it("streams deltas into message_update events and keeps them in the final message", async () => {
    const { provider } = makeProvider([streamingReply])
    const { events, messages } = await runLoop(baseConfig(), provider)

    const updates = eventsOfType(events, "message_update")
    expect(updates.map((u) => u.delta)).toEqual([
      { text: "Hel" },
      { thinking: "deep work" },
      { toolCall: { type: "toolCall", id: "pending", name: "search", arguments: {} } },
    ])
    // placeholder() builds the message shown mid-stream: thinking + text + partial tool call.
    const last = updates[2]?.message
    expect(last?.content.some((c) => c.type === "thinking" && c.text === "deep work")).toBe(true)
    expect(last?.content.some((c) => c.type === "toolCall" && c.name === "search")).toBe(true)

    const assistants = messages.filter((m): m is AssistantMessage => m.role === "assistant")
    const final = assistants[assistants.length - 1]
    expect(final?.content.some((c) => c.type === "thinking" && c.text === "deep work")).toBe(true)
    expect(final?.content.some((c) => c.type === "text" && c.text === "Hel")).toBe(true)
  })

  it("a failing event sink never breaks the stream", async () => {
    const { provider } = makeProvider([streamingReply])
    const { events, messages } = await runLoop(baseConfig(), provider, {
      onEvent: (event) => {
        if (event.type === "message_update") {
          throw new Error("sink down")
        }
      },
    })

    expect(eventsOfType(events, "message_update")).toHaveLength(0) // swallowed by the queue
    expect(eventsOfType(events, "agent_end")).toHaveLength(1)
    expect(assistantTexts(messages).join("\n")).toContain("Hel")
  })
})

/* ─────────────────── tool-call guards ─────────────────── */

describe("tool-call guards", () => {
  it("blocks a repeating tool-call loop after a permission prompt", async () => {
    const executed: string[] = []
    const { provider, calls } = makeProvider([toolReply("c1", "probe", { n: 1 })])
    const { events, messages } = await runLoop(baseConfig({ maxTurns: 4 }), provider, {
      tools: [probeTool("probe", executed)],
      onRequestPermission: async () => {
        return /*denied*/ false
      },
    })

    expect(calls()).toBe(4)
    expect(executed).toHaveLength(2) // turns 1–2 ran; turns 3–4 were blocked
    const doomRequests = eventsOfType(events, "permission_request").filter((e) => e.tool === "doom_loop")
    expect(doomRequests).toHaveLength(2)
    expect(eventsOfType(events, "permission_response").filter((e) => e.allowed === false)).toHaveLength(2)
    const blocked = toolTexts(messages).filter((t) => t.includes("blocked a repeating tool-call loop"))
    expect(blocked).toHaveLength(2)
  })

  it("stops executing after the per-prompt tool-call limit", async () => {
    const executed: string[] = []
    const { provider } = makeProvider([
      toolReply("c1", "probe", { n: 1 }),
      toolReply("c2", "probe", { n: 2 }),
      toolReply("c3", "probe", { n: 3 }),
    ])
    const { messages } = await runLoop(baseConfig({ maxTurns: 3, maxToolCalls: 1, toolCallRate: 0 }), provider, {
      tools: [probeTool("probe", executed)],
    })

    expect(executed).toEqual(['{"n":1}'])
    const limited = toolTexts(messages).filter((t) => t.includes("Tool-call limit reached (1 per prompt)"))
    expect(limited).toHaveLength(2) // turns 2 and 3 were skipped
  })

  it("skips a new tool once the distinct-tool budget is spent", async () => {
    const alphaDone: string[] = []
    const betaDone: string[] = []
    const { provider } = makeProvider([
      toolReply("c1", "alpha", { n: 1 }),
      toolReply("c2", "beta", { n: 2 }),
      toolReply("c3", "beta", { n: 3 }),
    ])
    const { messages } = await runLoop(baseConfig({ maxTurns: 3, maxDistinctToolCalls: 1 }), provider, {
      tools: [probeTool("alpha", alphaDone), probeTool("beta", betaDone)],
    })

    expect(alphaDone).toEqual(['{"n":1}'])
    expect(betaDone).toHaveLength(0)
    const skipped = toolTexts(messages).filter((t) => t.includes("Distinct tool limit reached (1 per session)"))
    expect(skipped).toHaveLength(2) // both beta calls rejected
  })

  it("denies a tool blocked by a permission rule without asking", async () => {
    const executed: string[] = []
    const config = baseConfig({
      maxTurns: 2,
      permissions: {
        mode: "default",
        rules: [{ tool: "probe", pattern: "*", allow: false }],
        askByDefault: true,
      },
    })
    const { provider } = makeProvider([toolReply("c1", "probe", { n: 1 }), textReply("done")])
    const { events, messages } = await runLoop(config, provider, {
      tools: [probeTool("probe", executed)],
    })

    expect(executed).toHaveLength(0)
    const denied = toolTexts(messages).join("\n")
    expect(denied).toContain("Trayambak permission denied for probe:")
    expect(denied).toContain("denied by rule")
    expect(eventsOfType(events, "permission_request")).toHaveLength(0) // deny never asks
  })

  it("blocks an asked tool when no approval handler is attached", async () => {
    const executed: string[] = []
    const config = baseConfig({
      maxTurns: 2,
      permissions: { mode: "default", rules: [], askByDefault: true },
    })
    const { provider } = makeProvider([toolReply("c1", "probe", { n: 1 }), textReply("done")])
    const { events, messages } = await runLoop(config, provider, {
      tools: [probeTool("probe", executed)],
    })

    expect(executed).toHaveLength(0)
    expect(toolTexts(messages).join("\n")).toContain("Trayambak permission denied for probe. Tool execution blocked.")
    expect(eventsOfType(events, "permission_request").filter((e) => e.tool === "probe")).toHaveLength(1)
    expect(eventsOfType(events, "permission_response").filter((e) => e.allowed === false)).toHaveLength(1)
  })

  it("runs the tool when the approval handler approves", async () => {
    const executed: string[] = []
    const config = baseConfig({
      maxTurns: 2,
      permissions: { mode: "default", rules: [], askByDefault: true },
    })
    const { provider } = makeProvider([toolReply("c1", "probe", { n: 1 }), textReply("done")])
    const { events, messages } = await runLoop(config, provider, {
      tools: [probeTool("probe", executed)],
      onRequestPermission: async () => {
        return /*approved*/ true
      },
    })

    expect(executed).toEqual(['{"n":1}'])
    expect(toolTexts(messages)).toContain("did:probe")
    expect(eventsOfType(events, "permission_response").filter((e) => e.allowed === true)).toHaveLength(1)
  })

  it("reports unknown tools instead of crashing", async () => {
    const { provider } = makeProvider([toolReply("c1", "ghost", {}), textReply("done")])
    const { messages } = await runLoop(baseConfig({ maxTurns: 2 }), provider)

    expect(toolTexts(messages).join("\n")).toContain("Unknown tool: ghost")
    expect(assistantTexts(messages).join("\n")).toContain("done")
  })

  it("captures tool exceptions as error results", async () => {
    const executed: string[] = []
    const { provider } = makeProvider([toolReply("c1", "probe", { n: 1 }), textReply("done")])
    const { messages } = await runLoop(baseConfig({ maxTurns: 2 }), provider, {
      tools: [probeTool("probe", executed, { throwMessage: "kaboom" })],
    })

    expect(toolTexts(messages).join("\n")).toContain("Tool error: kaboom")
    expect(executed).toHaveLength(0) // threw before recording
  })

  it("times out a hung tool instead of blocking the loop", async () => {
    const executed: string[] = []
    const { provider } = makeProvider([toolReply("c1", "probe", { n: 1 }), textReply("done")])
    const { messages } = await runLoop(baseConfig({ maxTurns: 2, timeoutMs: 40 }), provider, {
      tools: [probeTool("probe", executed, { delayMs: 300 })],
    })

    expect(toolTexts(messages).join("\n")).toContain("Tool timed out: probe (40ms)")
    expect(assistantTexts(messages).join("\n")).toContain("done")
  })

  it("runs sequential tools serially in call order", async () => {
    const order: string[] = []
    const twoCalls: Reply = () => ({
      role: "assistant",
      content: [
        { type: "toolCall", id: "c1", name: "seq", arguments: { label: "first" } },
        { type: "toolCall", id: "c2", name: "seq", arguments: { label: "second" } },
      ],
      stopReason: "tool_use",
    })
    const { provider } = makeProvider([twoCalls, textReply("done")])
    await runLoop(baseConfig({ maxTurns: 3 }), provider, { tools: [sequentialTool(order)] })

    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"])
  })

  it("waits out the rate window when calls exceed toolCallRate", async () => {
    const executed: string[] = []
    const { provider } = makeProvider([
      toolReply("c1", "probe", { n: 1 }),
      toolReply("c2", "probe", { n: 2 }),
      textReply("done"),
    ])
    const started = Date.now()
    const { messages } = await runLoop(baseConfig({ maxTurns: 4, toolCallRate: 1 }), provider, {
      tools: [probeTool("probe", executed)],
    })

    expect(executed).toHaveLength(2)
    expect(toolTexts(messages).filter((t) => t === "did:probe")).toHaveLength(2)
    expect(Date.now() - started).toBeGreaterThanOrEqual(900) // second call waited out the 1s window
  })
})

/* ───────────── extraction, hooks, verification, context ───────────── */

describe("text-fence extraction, hooks, verification, context", () => {
  it("extracts tool calls embedded in model text (fallback parser)", async () => {
    const executed: string[] = []
    const fence = 'Let me probe now. <tool_call:6124c78e>{"name":"probe","arguments":{"n":7}}</tool_call>'
    const { provider } = makeProvider([textReply(fence), textReply("done")])
    const { messages } = await runLoop(baseConfig({ maxTurns: 4 }), provider, {
      tools: [probeTool("probe", executed)],
    })

    expect(executed).toEqual(['{"n":7}'])
    const withCall = messages
      .filter((m): m is AssistantMessage => m.role === "assistant")
      .find((m) => m.content.some((c) => c.type === "toolCall"))
    expect(withCall).toBeDefined()
    expect(
      withCall?.content.some(
        (c) => c.type === "text" && c.text.includes("Let me probe now.") && !c.text.includes("<tool_call"),
      ),
    ).toBe(true)
    expect(toolTexts(messages)).toContain("did:probe")
  })

  it("routes a hook's ask verdict through the approval gate", async () => {
    const executed: string[] = []
    const asked: string[] = []
    const hookExecutor: HookShellExecutor = {
      run: async () => ({
        exitCode: 0,
        stdout: {
          text: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "ask",
              permissionDecisionReason: "confirm first",
            },
          }),
        },
        stderr: { text: "" },
      }),
    }
    const config = baseConfig({
      maxTurns: 2,
      hooks: { preToolUse: [{ matcher: "probe", hooks: [{ command: "gate.sh" }] }] },
    })
    const { provider } = makeProvider([toolReply("c1", "probe", { n: 1 }), textReply("done")])
    const { events, messages } = await runLoop(config, provider, {
      tools: [probeTool("probe", executed)],
      hookExecutor,
      onRequestPermission: async (tool) => {
        asked.push(tool)
        return /*denied*/ false
      },
    })

    expect(asked).toEqual(["probe"])
    expect(executed).toHaveLength(0)
    expect(toolTexts(messages).join("\n")).toContain("Hook-gated probe was not approved.")
    expect(eventsOfType(events, "permission_request").filter((e) => e.reason === "confirm first")).toHaveLength(1)
  })

  it("emits verification steps and records mistakes when developer mode watches", async () => {
    const mistakes: unknown[] = []
    const developerMode = developerModeWith({
      stepByStep: true,
      observeMistakes: true,
      mistakes,
    })
    const { provider } = makeProvider([toolReply("c1", "ghost", {}), textReply("done")])
    const { events } = await runLoop(baseConfig({ maxTurns: 2 }), provider, { developerMode })

    expect(eventsOfType(events, "verification_start")).toHaveLength(1)
    expect(eventsOfType(events, "verification_step")).toHaveLength(5)
    const end = eventsOfType(events, "verification_end")[0]
    expect(end?.passed).toBe(false)
    expect(end?.steps.find((s) => s.name === "build")?.status).toBe("fail")
    expect(events[events.length - 1]?.type).toBe("ready_for_verification")
    expect(mistakes.some((m) => (m as { type?: string }).type === "wrong_tool")).toBe(true)
  })

  it("passes verification on a clean run (skipped linters, no tool errors)", async () => {
    const developerMode = developerModeWith({ stepByStep: true, observeMistakes: false })
    const { provider } = makeProvider([textReply("done")])
    const { events } = await runLoop(baseConfig({ maxTurns: 2 }), provider, { developerMode })

    const end = eventsOfType(events, "verification_end")[0]
    expect(end?.passed).toBe(true)
    expect(end?.steps.find((s) => s.name === "build")?.status).toBe("pass")
    expect(end?.steps.find((s) => s.name === "consistency")?.status).toBe("skip")
    expect(events[events.length - 1]?.type).toBe("ready_for_verification")
  })

  it("force-compacts a too-large session on context overflow and retries", async () => {
    const session = new Session()
    const big = "lorem ipsum ".repeat(400) // ~4800 chars ≈ 1200 estimated tokens
    session.add({ role: "user", content: `question one ${big}` })
    session.add({
      role: "assistant",
      content: [{ type: "text", text: `answer one ${big}` }],
      stopReason: "end_turn",
    })
    session.add({ role: "user", content: `question two ${big}` })
    session.add({
      role: "assistant",
      content: [{ type: "text", text: `answer two ${big}` }],
      stopReason: "end_turn",
    })
    const { provider, calls } = makeProvider([
      failReply("model: request exceeds the available context window"),
      textReply("fits now"),
    ])
    const { events, messages } = await runLoop(baseConfig({ contextWindow: 1024, maxTurns: 3 }), provider, { session })

    expect(calls()).toBe(2) // overflow failure + successful retry
    expect(eventsOfType(events, "compaction").length).toBeGreaterThanOrEqual(1)
    const first = messages[0]
    expect(first?.role === "user" && first.content.startsWith("[Context auto-compaction]")).toBe(true)
    expect(assistantTexts(messages).join("\n")).toContain("fits now")
  })

  it("ends immediately when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const { provider, calls } = makeProvider([textReply("never")])
    const { events } = await runLoop(baseConfig(), provider, { signal: controller.signal })

    expect(calls()).toBe(0)
    expect(eventsOfType(events, "agent_end")).toHaveLength(1)
    expect(streamedErrors(events)).toHaveLength(0)
  })
})
