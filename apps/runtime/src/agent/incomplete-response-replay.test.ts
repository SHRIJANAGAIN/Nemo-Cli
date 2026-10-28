/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Incomplete-response replay (#122).
 *
 * A stream can die mid-answer: the socket drops, the gateway truncates, the
 * provider gives up. When that happens the assistant message still carries the
 * text it managed to emit, so the loop used to ACCEPT the fragment as a
 * finished reply — the user saw half a sentence and the turn simply ended.
 * That is the "agent response gets cut" report.
 *
 * The fix replays the turn instead of settling it, and discards the fragment
 * so the retried answer is not appended to the severed one. Replay is bounded:
 * a provider that is permanently incomplete must still terminate.
 *
 * Two signals mark an incomplete reply, both already present in the protocol:
 *   - `stopReason === "error"` with content — an errored turn that still
 *     emitted partial output.
 *   - a tool call whose arguments carry the `__partial` marker that
 *     `placeholder()` sets when the stream was cut mid tool-call.
 */
import * as os from "os"
import { describe, expect, it } from "vitest"
import { runAgentLoop } from "./agent-loop.js"
import { Session } from "../session/session.js"
import type { AgentMessage } from "../../../../packages/protocol/src/index.js"
import type { NemoConfig } from "../config.js"

const cfg = {
  maxTurns: 20,
  maxRetries: 0,
  retryDelayMs: 50,
  maxToolCalls: 5,
  cwd: os.tmpdir(),
  permissions: { mode: "default", rules: [], askByDefault: true },
} as unknown as NemoConfig

/** Counts provider calls so "did it replay?" is observable, not inferred. */
function countedProvider(replies: unknown[]) {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    chat: async () => {
      const reply = replies[Math.min(calls, replies.length - 1)]
      calls++
      return reply
    },
  }
}

const partialText = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "error",
})

const partialToolCall = (args: string) => ({
  role: "assistant",
  content: [{ type: "toolCall", id: "tc1", name: "read_file", arguments: { __partial: args } }],
  stopReason: "tool_use",
})

const complete = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "end_turn",
})

const assistants = (s: Session): string[] =>
  s.messages
    .filter((m: AgentMessage) => m.role === "assistant")
    .flatMap((m: AgentMessage) =>
      (m.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text ?? ""),
    )

describe("runAgentLoop incomplete-response replay", () => {
  it("replays a turn that errored mid-answer and keeps only the clean reply", async () => {
    const provider = countedProvider([
      partialText("Here is the first half of th"),
      complete("Here is the whole answer."),
    ])
    const session = new Session()
    await runAgentLoop("explain the module", {
      provider: provider as never,
      tools: [],
      session,
      config: cfg,
      emit: async () => {},
    })
    expect(provider.calls).toBe(2)
    const texts = assistants(session)
    // The severed fragment must NOT survive into the transcript — appending to
    // it is exactly what produced "cut" answers in the first place.
    expect(texts.join("")).toBe("Here is the whole answer.")
    expect(texts.join("")).not.toContain("first half of th")
  }, 15000)

  it("replays a tool call whose arguments were cut off by the stream", async () => {
    const provider = countedProvider([partialToolCall('{"path":"src/ind'), complete("Read the file for you.")])
    const session = new Session()
    await runAgentLoop("read src/index.ts", {
      provider: provider as never,
      tools: [],
      session,
      config: cfg,
      emit: async () => {},
    })
    expect(provider.calls).toBe(2)
    // The malformed call must never reach tool execution, so no tool-result
    // message and no half-parsed arguments survive in the session.
    expect(session.messages.filter((m: AgentMessage) => m.role === "tool")).toHaveLength(0)
  }, 15000)

  it("does not replay a clean answer", async () => {
    const provider = countedProvider([complete("All done, nothing to add.")])
    const session = new Session()
    await runAgentLoop("status?", {
      provider: provider as never,
      tools: [],
      session,
      config: cfg,
      emit: async () => {},
    })
    expect(provider.calls).toBe(1)
  }, 15000)

  it("gives up after the replay budget instead of looping forever", async () => {
    // Permanently incomplete provider: the bound is what stops the run.
    const provider = countedProvider([partialText("still going, cut off ag")])
    const session = new Session()
    await runAgentLoop("never finishes", {
      provider: provider as never,
      tools: [],
      session,
      config: cfg,
      emit: async () => {},
    })
    // 1 initial attempt + the replay budget, never the 20-turn config ceiling.
    expect(provider.calls).toBeGreaterThan(1)
    expect(provider.calls).toBeLessThanOrEqual(4)
  }, 15000)

  it("never replays an aborted turn", async () => {
    const provider = countedProvider([partialText("cut")])
    const session = new Session()
    await runAgentLoop("stop me", {
      provider: provider as never,
      tools: [],
      session,
      config: cfg,
      emit: async () => {},
      signal: AbortSignal.abort(),
    })
    expect(provider.calls).toBe(0)
  }, 15000)
})
