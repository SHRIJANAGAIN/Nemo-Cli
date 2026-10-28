/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { PassThrough } from "stream"
import { runAcpServer } from "./index.js"

/**
 * Drives runAcpServer() end-to-end over a fake stdio pair: JSON-RPC lines are
 * written into a PassThrough swapped in for process.stdin, and every
 * process.stdout.write is captured and parsed back into messages.
 *
 * The heavy dependencies are mocked at the module boundary:
 *  - `apps/runtime/src/index.js` (Agent + loadConfig) so no model/provider is
 *    ever constructed, and
 *  - `session-backends/src/transcript.js` so session ids are deterministic and
 *    no real transcript files are written.
 */

const h = vi.hoisted(() => {
  // Real AgentEvent shapes, not invented ones: `session/update` forwards only
  // events that map to an ACP SessionUpdate, so `{type:"text"}` would be
  // dropped and every assertion below would see zero updates.
  // `signal` mirrors Agent.run's 3rd parameter so tests can observe the
  // session/cancel → AbortSignal wiring (production passes it through).
  type RunImpl = (
    prompt: string,
    model: string | undefined,
    emit: (event: unknown) => void,
    signal?: AbortSignal,
  ) => Promise<void>
  const defaultRun: RunImpl = (_prompt, _model, emit) => {
    emit({ type: "message_update", delta: { text: "chunk" } })
    return Promise.resolve()
  }

  const state = {
    loadConfigCalls: [] as Array<Record<string, unknown>>,
    runs: [] as Array<{
      prompt: string
      model: string | undefined
      emit: (event: unknown) => void
      signal?: AbortSignal
    }>,
    agentCreates: [] as Array<{ config: { model?: string } }>,
    runImpl: defaultRun,
    transcripts: [] as Array<{ id: string; state: Record<string, unknown> }>,
    createCalls: [] as string[],
    transcriptSeq: 0,
    readStateImpl: (_id: string): unknown => null,
    reset(): void {
      state.loadConfigCalls.length = 0
      state.runs.length = 0
      state.agentCreates.length = 0
      state.transcripts.length = 0
      state.createCalls.length = 0
      state.transcriptSeq = 0
      state.runImpl = defaultRun
      state.readStateImpl = () => null
    },
  }
  return state
})

vi.mock("../../../apps/runtime/src/index.js", () => ({
  loadConfig: (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    h.loadConfigCalls.push(overrides)
    return { model: "default-model", ...overrides }
  },
  Agent: class MockAgent {
    // Agent.create is the MCP/skills-loading path: production must call it,
    // not the bare constructor — the constructor skipped buildOptionalTools
    // entirely, so ACP never connected configured MCP servers (#62).
    static async create(options: { config: { model?: string } }): Promise<MockAgent> {
      h.agentCreates.push(options)
      return new MockAgent(options)
    }
    private readonly config: { model?: string }
    constructor(options: { config: { model?: string } }) {
      this.config = options.config
    }
    run(prompt: string, emit: (event: unknown) => void, signal?: AbortSignal): Promise<void> {
      h.runs.push({ prompt, model: this.config.model, emit, signal })
      return h.runImpl(prompt, this.config.model, emit, signal)
    }
  },
}))

vi.mock("../../session-backends/src/transcript.js", () => ({
  createTranscript: (workDir: string): { id: string } => {
    h.createCalls.push(workDir)
    h.transcriptSeq += 1
    const id = `sess_${h.transcriptSeq}`
    h.transcripts.push({ id, state: { cwd: workDir } })
    return { id }
  },
  listTranscripts: (): Array<{ id: string; state: Record<string, unknown> }> => h.transcripts,
  readState: (id: string): unknown => h.readStateImpl(id),
}))

interface RpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string }
}

let out = ""
// Structural type: only mockRestore() is called, and the concrete overload
// set of process.stdout.write doesn't fit vitest's default MockInstance.
let writeSpy: { mockRestore: () => void } | undefined
let savedStdin: PropertyDescriptor | undefined
let fakeStdin: PassThrough

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

const messages = (): RpcMessage[] =>
  out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RpcMessage)

const sendLine = async (payload: unknown): Promise<void> => {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload)
  fakeStdin.write(`${text}\n`)
  await flush()
}

beforeEach(() => {
  h.reset()
  out = ""
  writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array): boolean => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    return true
  }) as unknown as typeof process.stdout.write)

  savedStdin = Object.getOwnPropertyDescriptor(process, "stdin")
  fakeStdin = new PassThrough()
  Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true, writable: true })
})

afterEach(() => {
  fakeStdin.destroy()
  writeSpy?.mockRestore()
  writeSpy = undefined
  if (savedStdin) Object.defineProperty(process, "stdin", savedStdin)
})

describe("ACP server session lifecycle", () => {
  it("initialize reports protocol version, capabilities and agent info", async () => {
    runAcpServer()
    await sendLine({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })

    const [msg] = messages()
    expect(msg.jsonrpc).toBe("2.0")
    expect(msg.id).toBe(1)
    expect(msg.result).toMatchObject({
      protocolVersion: 1,
      // Spec-shaped: the short keys we used to send were dropped by every
      // client, so they advertised nothing.
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: {},
        auth: {},
      },
      agentInfo: { name: "nemo" },
    })
  })

  it("never replies to a request that carries no id", async () => {
    runAcpServer()
    await sendLine({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: 1 } })
    expect(messages()).toEqual([])
  })

  it("new_session creates a transcript in the requested workDir", async () => {
    runAcpServer()
    await sendLine({ jsonrpc: "2.0", id: 2, method: "new_session", params: { workDir: "C:/ws" } })

    expect(h.createCalls).toEqual(["C:/ws"])
    expect(messages()[0].result).toEqual({ sessionId: "sess_1" })
  })

  it("new_session falls back to process.cwd() when workDir is absent", async () => {
    runAcpServer()
    await sendLine({ jsonrpc: "2.0", id: 2, method: "new_session" })

    expect(h.createCalls).toEqual([process.cwd()])
  })

  it("load_session returns stored state, resume_session is an alias, unknown sessions error", async () => {
    runAcpServer()
    h.readStateImpl = (id) => (id === "known" ? { cwd: "/w" } : null)

    await sendLine({ jsonrpc: "2.0", id: 3, method: "load_session", params: { sessionId: "known" } })
    expect(messages()[0].result).toEqual({ sessionId: "known", state: { cwd: "/w" } })

    await sendLine({ jsonrpc: "2.0", id: 4, method: "resume_session", params: { sessionId: "known" } })
    expect(messages()[1].result).toEqual({ sessionId: "known", state: { cwd: "/w" } })

    await sendLine({ jsonrpc: "2.0", id: 5, method: "load_session", params: { sessionId: "ghost" } })
    expect(messages()[2].error).toEqual({ code: -32001, message: "session not found: ghost" })
  })

  it("list_sessions maps every transcript to sessionId plus its state", async () => {
    runAcpServer()
    h.transcripts.push({ id: "t1", state: { cwd: "/a" } }, { id: "t2", state: { cwd: "/b" } })

    await sendLine({ jsonrpc: "2.0", id: 6, method: "list_sessions" })
    expect(messages()[0].result).toEqual([
      { sessionId: "t1", cwd: "/a" },
      { sessionId: "t2", cwd: "/b" },
    ])
  })

  it("set_model echoes the chosen model, or null when none was sent", async () => {
    runAcpServer()
    await sendLine({ jsonrpc: "2.0", id: 7, method: "set_model", params: { model: "m1" } })
    await sendLine({ jsonrpc: "2.0", id: 8, method: "set_model" })

    const msgs = messages()
    expect(msgs[0].result).toEqual({ ok: true, model: "m1" })
    expect(msgs[1].result).toEqual({ ok: true, model: null })
  })

  it("set_model's reply is backed by state the next prompt actually reads (#60)", async () => {
    runAcpServer()
    // Session-scoped choice…
    await sendLine({ jsonrpc: "2.0", id: 20, method: "set_model", params: { sessionId: "sm1", model: "stored-model" } })
    await sendLine({ jsonrpc: "2.0", id: 21, method: "prompt", params: { sessionId: "sm1", prompt: "hi" } })
    // …an explicit per-prompt model still wins…
    await sendLine({
      jsonrpc: "2.0",
      id: 22,
      method: "prompt",
      params: { sessionId: "sm1", prompt: "again", model: "override-model" },
    })
    // …and a process-wide choice covers sessions that never got one.
    await sendLine({ jsonrpc: "2.0", id: 23, method: "set_model", params: { model: "default-choice" } })
    await sendLine({ jsonrpc: "2.0", id: 24, method: "prompt", params: { sessionId: "sm2", prompt: "third" } })

    // notifications (session/update) interleave with responses — pick by id
    const msgs = messages()
    const reply = (id: number): { result?: unknown; error?: unknown } => msgs.find((m) => m.id === id) ?? {}
    expect(reply(20).result).toEqual({ ok: true, model: "stored-model" })
    expect(h.runs[0].model).toBe("stored-model")
    expect(h.runs[1].model).toBe("override-model")
    expect(h.runs[2].model).toBe("default-choice")
    expect(reply(23).result).toEqual({ ok: true, model: "default-choice" })
  })

  it("rejects a non-string, non-null model with -32602 instead of echoing it", async () => {
    runAcpServer()
    await sendLine({ jsonrpc: "2.0", id: 25, method: "set_model", params: { model: 42 } })

    expect(messages()[0].error).toEqual({ code: -32602, message: "'model' must be a string or null" })
  })

  it("rejects unknown methods with -32601", async () => {
    runAcpServer()
    await sendLine({ jsonrpc: "2.0", id: 9, method: "definitely_not_a_method" })

    expect(messages()[0].error).toEqual({ code: -32601, message: "unknown method: definitely_not_a_method" })
  })
})

describe("ACP server stdio robustness", () => {
  it("ignores blank and whitespace-only lines without responding", async () => {
    runAcpServer()
    await sendLine("")
    await sendLine("   ")

    expect(messages()).toEqual([])
  })

  it("drops malformed JSON and keeps serving later requests", async () => {
    runAcpServer()
    await sendLine('{"jsonrpc": "2.0", "id": 9, "method": ')
    await sendLine({ jsonrpc: "2.0", id: 10, method: "set_model", params: { model: "m" } })

    const msgs = messages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].id).toBe(10)
    expect(msgs[0].result).toEqual({ ok: true, model: "m" })
  })
})

describe("ACP server prompt and cancel", () => {
  it("rejects a prompt that has no prompt field with -32602", async () => {
    runAcpServer()
    await sendLine({ jsonrpc: "2.0", id: 1, method: "prompt", params: { sessionId: "s1" } })

    expect(messages()[0].error).toEqual({ code: -32602, message: "missing 'prompt'" })
    expect(h.runs).toEqual([])
  })

  it("runs the agent with the requested model, streams session/update, replies end_turn", async () => {
    runAcpServer()
    await sendLine({
      jsonrpc: "2.0",
      id: 2,
      method: "prompt",
      params: { sessionId: "s2", prompt: "hello", model: "m1" },
    })

    expect(h.loadConfigCalls).toContainEqual({ model: "m1" })
    // The prompt path must build the agent through Agent.create — the
    // constructor never loads config-driven MCP/skill tools (#62).
    expect(h.agentCreates).toHaveLength(1)
    expect(h.runs).toHaveLength(1)
    expect(h.runs[0].prompt).toBe("hello")
    expect(h.runs[0].model).toBe("m1")
    expect(messages()).toEqual([
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s2",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "chunk" } },
        },
      },
      { jsonrpc: "2.0", id: 2, result: { sessionId: "s2", stopReason: "end_turn" } },
    ])
  })

  it("creates a transcript for prompts that carry no sessionId", async () => {
    runAcpServer()
    await sendLine({ jsonrpc: "2.0", id: 3, method: "prompt", params: { prompt: "hi" } })

    expect(h.createCalls).toEqual([process.cwd()])
    const [, resp] = messages()
    expect(resp.result).toEqual({ sessionId: "sess_1", stopReason: "end_turn" })
  })

  it("surfaces agent failures as -32000 with the original message", async () => {
    runAcpServer()
    h.runImpl = () => Promise.reject(new Error("provider exploded"))

    await sendLine({ jsonrpc: "2.0", id: 4, method: "prompt", params: { sessionId: "s4", prompt: "hi" } })

    expect(messages()[0].error).toEqual({ code: -32000, message: "provider exploded" })
  })

  it("cancel acknowledges immediately and suppresses later session/update events", async () => {
    runAcpServer()
    let finish: (() => void) | undefined
    h.runImpl = (_prompt, _model, emit) =>
      new Promise<void>((resolve) => {
        emit({ type: "message_update", delta: { text: "early" } })
        finish = () => {
          emit({ type: "message_update", delta: { text: "late" } })
          resolve()
        }
      })

    await sendLine({ jsonrpc: "2.0", id: 5, method: "prompt", params: { sessionId: "cancel-1", prompt: "go" } })
    expect(messages().filter((m) => m.method === "session/update")).toHaveLength(1)

    await sendLine({ jsonrpc: "2.0", id: 6, method: "cancel", params: { sessionId: "cancel-1" } })
    expect(messages().find((m) => m.id === 6)?.result).toEqual({ ok: true })

    if (!finish) throw new Error("agent.run was never invoked")
    finish()
    await flush()

    const updates = messages().filter((m) => m.method === "session/update")
    expect(updates).toHaveLength(1) // the post-cancel event was suppressed
    expect(updates[0].params).toMatchObject({
      sessionId: "cancel-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "early" } },
    })

    // Cancellation is reported truthfully: handlePrompt reads the flag
    // before clearing it (the old order deleted first, which made
    // "cancelled" unreachable — every reply said "end_turn", even
    // mid-cancel ones).
    expect(messages().find((m) => m.id === 5)?.result).toEqual({
      sessionId: "cancel-1",
      stopReason: "cancelled",
    })
  })

  it("cancel aborts the in-flight run, and an idle cancel poisons nothing", async () => {
    runAcpServer()
    let seenSignal: AbortSignal | undefined
    let aborted = false
    h.runImpl = (_prompt, _model, emit, signal) => {
      seenSignal = signal
      return new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => {
          aborted = true
          emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } })
          resolve()
        })
      })
    }

    // Deliberately not awaited: the prompt must still be in flight below.
    sendLine({ jsonrpc: "2.0", id: 11, method: "prompt", params: { sessionId: "kill-1", prompt: "go" } })
    await flush()
    expect(seenSignal).toBeDefined() // the run received cancel's AbortSignal

    await sendLine({ jsonrpc: "2.0", id: 12, method: "cancel", params: { sessionId: "kill-1" } })
    expect(messages().find((m) => m.id === 12)?.result).toEqual({ ok: true })
    // The run stops where it stands (was: cosmetic — events were hidden
    // while the model kept generating to completion, tokens spent).
    expect(aborted).toBe(true)
    expect(seenSignal?.aborted).toBe(true)
    await flush()
    expect(messages().find((m) => m.id === 11)?.result).toEqual({
      sessionId: "kill-1",
      stopReason: "cancelled",
    })

    // An idempotent cancel AFTER completion must not poison the next
    // prompt (was: the flag lingered with no run to clear it, so this
    // prompt's events were suppressed from the first delta and its reply
    // was mislabeled "cancelled").
    await sendLine({ jsonrpc: "2.0", id: 13, method: "cancel", params: { sessionId: "kill-1" } })
    expect(messages().find((m) => m.id === 13)?.result).toEqual({ ok: true })
    h.runImpl = (_prompt, _model, emit) => {
      emit({ type: "message_update", delta: { text: "clean" } })
      return Promise.resolve()
    }
    await sendLine({ jsonrpc: "2.0", id: 14, method: "prompt", params: { sessionId: "kill-1", prompt: "again" } })

    const cleanChunk = messages()
      .filter((m) => m.method === "session/update")
      .find((m) => JSON.stringify(m.params).includes("clean"))
    expect(cleanChunk).toBeDefined() // not suppressed
    expect(messages().find((m) => m.id === 14)?.result).toEqual({
      sessionId: "kill-1",
      stopReason: "end_turn",
    })
  })

  it("a cancel flag does not outlive a failed run — the next prompt still streams", async () => {
    runAcpServer()
    let rejectRun: ((err: Error) => void) | undefined
    h.runImpl = (_prompt, _model, emit) =>
      new Promise<void>((_resolve, reject) => {
        emit({ type: "message_update", delta: { text: "first" } })
        rejectRun = reject
      })

    await sendLine({ jsonrpc: "2.0", id: 7, method: "prompt", params: { sessionId: "leak-1", prompt: "go" } })
    await sendLine({ jsonrpc: "2.0", id: 8, method: "cancel", params: { sessionId: "leak-1" } })
    expect(messages().find((m) => m.id === 8)?.result).toEqual({ ok: true })

    if (!rejectRun) throw new Error("agent.run was never invoked")
    rejectRun(new Error("provider exploded"))
    await flush()
    expect(messages().find((m) => m.id === 7)?.error).toEqual({ code: -32000, message: "provider exploded" })

    // Same session, healthy run: the flag cleared by the failed run's
    // cleanup must not linger — otherwise this prompt's events would be
    // silently suppressed and it would be mislabeled "cancelled".
    h.runImpl = (_prompt, _model, emit) => {
      emit({ type: "message_update", delta: { text: "back" } })
      return Promise.resolve()
    }
    await sendLine({ jsonrpc: "2.0", id: 9, method: "prompt", params: { sessionId: "leak-1", prompt: "again" } })

    const updates = messages()
      .filter((m) => m.method === "session/update")
      .map(
        (m) =>
          m.params as { sessionId?: string; update?: { content?: { text?: string } } } | undefined,
      )
      .filter((p) => p?.sessionId === "leak-1")
    expect(updates.some((p) => p?.update?.content?.text === "back")).toBe(true)
    expect(messages().find((m) => m.id === 9)?.result).toEqual({
      sessionId: "leak-1",
      stopReason: "end_turn",
    })
  })
})

describe("ACP spec conformance", () => {
  it("accepts session/new, session/load and session/resume under their spec names", async () => {
    runAcpServer()
    h.readStateImpl = (id) => (id === "known" ? { cwd: "/w" } : null)

    await sendLine({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/spec-ws", mcpServers: [] } })
    await sendLine({
      jsonrpc: "2.0",
      id: 2,
      method: "session/load",
      params: { sessionId: "known", cwd: "/w", mcpServers: [] },
    })
    await sendLine({ jsonrpc: "2.0", id: 3, method: "session/resume", params: { sessionId: "known", cwd: "/w" } })

    // The spec field is `cwd`, not `workDir` — it has to reach createTranscript.
    expect(h.createCalls).toEqual(["/spec-ws"])
    const msgs = messages()
    expect(msgs[0].result).toEqual({ sessionId: "sess_1" })
    expect(msgs[1].result).toEqual({ sessionId: "known", state: { cwd: "/w" } })
    expect(msgs[2].result).toEqual({ sessionId: "known", state: { cwd: "/w" } })
  })

  it("takes the spec ContentBlock[] prompt as well as a bare string", async () => {
    runAcpServer()
    await sendLine({
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: {
        sessionId: "s-blocks",
        prompt: [{ type: "text", text: "first " }, { type: "text", text: "second" }, { type: "image", data: "…" }],
      },
    })

    expect(h.runs[0].prompt).toBe("first second")
    expect(messages().at(-1)?.result).toEqual({ sessionId: "s-blocks", stopReason: "end_turn" })
  })

  it("rejects a ContentBlock[] prompt with no text in it instead of running empty", async () => {
    runAcpServer()
    await sendLine({
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: { sessionId: "s-empty", prompt: [{ type: "image", data: "…" }] },
    })

    expect(messages()[0].error).toEqual({ code: -32602, message: "missing 'prompt'" })
    expect(h.runs).toEqual([])
  })

  it("answers session/cancel as a notification with no frame and still stops the stream", async () => {
    runAcpServer()
    let finish: (() => void) | undefined
    h.runImpl = (_prompt, _model, emit) =>
      new Promise<void>((resolve) => {
        emit({ type: "message_update", delta: { text: "early" } })
        finish = () => {
          emit({ type: "message_update", delta: { text: "late" } })
          resolve()
        }
      })

    await sendLine({
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: { sessionId: "n1", prompt: [{ type: "text", text: "go" }] },
    })
    expect(messages().filter((m) => m.method === "session/update")).toHaveLength(1)

    // No `id` → notification, so nothing may be written back for it.
    await sendLine({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "n1" } })
    expect(messages()).toHaveLength(1)

    if (!finish) throw new Error("agent.run was never invoked")
    finish()
    await flush()

    expect(messages().filter((m) => m.method === "session/update")).toHaveLength(1)
    expect(messages().find((m) => m.id === 1)?.result).toEqual({ sessionId: "n1", stopReason: "cancelled" })
  })

  it("maps agent events onto SessionUpdate variants and drops the ones ACP has no shape for", async () => {
    runAcpServer()
    h.runImpl = (_prompt, _model, emit) => {
      emit({ type: "message_update", delta: { thinking: "hmm" } })
      emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } })
      emit({
        type: "tool_execution_update",
        toolCallId: "c1",
        toolName: "bash",
        partialResult: { content: [], isError: false },
      })
      emit({
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "ok" }], isError: false },
        isError: false,
      })
      emit({
        type: "tool_execution_end",
        toolCallId: "c2",
        toolName: "bash",
        result: { content: [], isError: true },
        isError: true,
      })
      // `rawInput` is typed `object` by the spec — a string payload must not be forwarded.
      emit({ type: "tool_execution_start", toolCallId: "c3", toolName: "t", args: "raw string" })
      emit({ type: "agent_end", messages: [] })
      return Promise.resolve()
    }

    await sendLine({ jsonrpc: "2.0", id: 1, method: "prompt", params: { sessionId: "map-1", prompt: "go" } })

    const updates = messages()
      .filter((m) => m.method === "session/update")
      .map((m) => (m.params as { update?: Record<string, unknown> }).update)

    expect(updates).toEqual([
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
      {
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        title: "bash",
        status: "in_progress",
        name: "bash",
        rawInput: { command: "ls" },
      },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "completed",
        rawOutput: { content: [{ type: "text", text: "ok" }], isError: false },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "c2",
        status: "failed",
        rawOutput: { content: [], isError: true },
      },
      { sessionUpdate: "tool_call", toolCallId: "c3", title: "t", status: "in_progress", name: "t" },
    ])
  })

  it("reports an unknown method under the name the client actually sent", async () => {
    runAcpServer()
    await sendLine({ jsonrpc: "2.0", id: 1, method: "session/nope" })

    expect(messages()[0].error).toEqual({ code: -32601, message: "unknown method: session/nope" })
  })
})

describe("ACP failure honesty and session liveness", () => {
  it("advertises the single-sourced root package version", async () => {
    runAcpServer()
    await sendLine({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })

    // Drift guard: a hardcoded literal went stale at 0.6.0 while the
    // release shipped 0.6.7 — the advertised version must track the root
    // package.json (via apps/cli/src/version.ts, stamped by sync-version).
    const rootPkg = JSON.parse(
      readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8"),
    ) as {
      version: string
    }
    expect(messages()[0].result).toMatchObject({
      agentInfo: { name: "nemo", version: rootPkg.version },
    })
  })

  it("an errored run forwards its text and answers stopReason error, not end_turn", async () => {
    runAcpServer()
    h.runImpl = (_prompt, _model, emit) => {
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "provider exploded mid-stream" }],
          stopReason: "error",
        },
      })
      return Promise.resolve()
    }

    await sendLine({ jsonrpc: "2.0", id: 2, method: "prompt", params: { sessionId: "err-1", prompt: "go" } })

    // Error text never streams as chunks — without the message_end
    // mapping the client saw nothing, while the reply claimed end_turn.
    expect(messages()[0]).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "err-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "provider exploded mid-stream" },
        },
      },
    })
    expect(messages()[1]).toEqual({ jsonrpc: "2.0", id: 2, result: { sessionId: "err-1", stopReason: "error" } })
  })

  it("a normal final message_end stays unmapped (its text already streamed)", async () => {
    runAcpServer()
    h.runImpl = (_prompt, _model, emit) => {
      emit({ type: "message_update", delta: { text: "answer" } })
      emit({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "answer" }], stopReason: "end_turn" },
      })
      return Promise.resolve()
    }

    await sendLine({ jsonrpc: "2.0", id: 3, method: "prompt", params: { sessionId: "norm-1", prompt: "go" } })

    // No duplicate chunk for already-streamed text; reply keeps end_turn.
    expect(messages().filter((m) => m.method === "session/update")).toHaveLength(1)
    expect(messages().at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: { sessionId: "norm-1", stopReason: "end_turn" },
    })
  })

  it("an internal aborted stopReason reads as cancelled", async () => {
    runAcpServer()
    h.runImpl = (_prompt, _model, emit) => {
      emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } })
      return Promise.resolve()
    }

    await sendLine({ jsonrpc: "2.0", id: 4, method: "prompt", params: { sessionId: "ab-1", prompt: "go" } })
    expect(messages()[0].result).toEqual({ sessionId: "ab-1", stopReason: "cancelled" })
  })

  it("pins the event loop until stdin closes, then releases it", async () => {
    const intervalSpy = vi.spyOn(global, "setInterval")
    const clearIntervalSpy = vi.spyOn(global, "clearInterval")
    try {
      runAcpServer()

      const entry = intervalSpy.mock.results
        .map((result, i) => ({ call: intervalSpy.mock.calls[i], handle: result.value }))
        .find(({ call }) => call?.[1] === 1 << 30)
      expect(entry).toBeDefined()
      // A ref'd timer handle is exactly what keeps Node's loop alive
      // while the harness still holds stdin open (its cleanup used to
      // signal an already-dead pid → ProcessLookupError → exit 1).
      const handle = entry?.handle as unknown as { hasRef?: () => boolean }
      expect(typeof handle?.hasRef).toBe("function")
      expect(handle.hasRef?.()).toBe(true)

      fakeStdin.destroy()
      await flush()
      // stdin EOF releases the pin — the loop may drain and exit now.
      expect(clearIntervalSpy).toHaveBeenCalledWith(entry?.handle)
    } finally {
      intervalSpy.mockRestore()
      clearIntervalSpy.mockRestore()
    }
  })
})
