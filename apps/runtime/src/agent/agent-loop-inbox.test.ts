/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { runAgentLoop } from "./agent-loop.js"
import { Session } from "../session/session.js"
import { sendToInbox } from "../tools/nemo/send-message.js"
import type { NemoConfig } from "../config.js"
import type { AgentMessage } from "../../../../packages/protocol/src/index.js"

/**
 * Inbox delivery inside the agent loop: a messageable subagent folds newly
 * arrived inbox messages in as user turns. Before the fix, SendMessage only
 * appended to a file nothing ever read — "agent doesn't receive my message".
 *
 * Isolation: the inbox lives under the OS home dir, so each test uses a
 * unique agent id and deletes its inbox file afterwards.
 */
describe("runAgentLoop inbox delivery", () => {
  const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const inboxId = `t-loop-${tag}`
  const cfg = {
    maxTurns: 3,
    maxRetries: 0,
    retryDelayMs: 50,
    maxToolCalls: 5,
    cwd: os.tmpdir(),
    permissions: { mode: "default", rules: [], askByDefault: true },
  } as unknown as NemoConfig
  const fakeProvider = {
    chat: async () => ({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
    }),
  } as never

  afterEach(() => {
    try {
      fs.rmSync(path.join(os.homedir(), ".nemo", "inbox", `${inboxId}.jsonl`), { force: true })
    } catch {
      /* best-effort cleanup */
    }
  })

  it("folds pre-seeded inbox messages into the run as user turns", async () => {
    sendToInbox(inboxId, "boss", "prioritize the auth module")
    const session = new Session()
    const seen: string[] = []
    await runAgentLoop("do the thing", {
      provider: fakeProvider,
      tools: [],
      session,
      config: cfg,
      emit: async (e) => {
        seen.push(e.type)
      },
      inboxId,
    })
    const injected = session.messages.filter(
      (m: AgentMessage) => m.role === "user" && m.content.includes("[message from boss]"),
    )
    expect(injected).toHaveLength(1)
    expect((injected[0] as { content: string }).content).toContain("prioritize the auth module")
  }, 15000)

  it("does not inject anything without an inboxId (foreground unchanged)", async () => {
    sendToInbox(`t-quiet-${tag}`, "boss", "you cannot hear me")
    const session = new Session()
    await runAgentLoop("do the thing", {
      provider: fakeProvider,
      tools: [],
      session,
      config: cfg,
      emit: async () => {},
    })
    const users = session.messages.filter((m: AgentMessage) => m.role === "user")
    // Only the prompt itself — no inbox polling, no stray rows.
    expect(users).toHaveLength(1)
    try {
      fs.rmSync(path.join(os.homedir(), ".nemo", "inbox", `t-quiet-${tag}.jsonl`), { force: true })
    } catch {
      /* best-effort cleanup */
    }
  }, 15000)
})

/**
 * Length-cut auto-continue: a maxTokens-exhausted answer (stopReason
 * "length", the "half response cut" report) nudges the model to continue
 * instead of ending the turn on a severed sentence. Bounded at 3.
 */
describe("runAgentLoop length continuation", () => {
  const cfg2 = {
    maxTurns: 20,
    maxRetries: 0,
    retryDelayMs: 50,
    maxToolCalls: 5,
    cwd: os.tmpdir(),
    permissions: { mode: "default", rules: [], askByDefault: true },
  } as unknown as NemoConfig

  function sequencingProvider(stops: Array<"length" | "end_turn">) {
    let i = 0
    return {
      chat: async () => {
        const stop = stops[Math.min(i++, stops.length - 1)]
        return {
          role: "assistant",
          content: [{ type: "text", text: `chunk ${i}` }],
          stopReason: stop,
        }
      },
    } as never
  }

  it("continues a length-cut answer with a nudge turn", async () => {
    const session = new Session()
    const starts: AgentMessage[] = []
    await runAgentLoop("list everything", {
      provider: sequencingProvider(["length", "end_turn"]),
      tools: [],
      session,
      config: cfg2,
      emit: async (e) => {
        if (e.type === "message_start" && (e.message as AgentMessage).role === "user") {
          starts.push(e.message as AgentMessage)
        }
      },
    })
    const assistants = session.messages.filter((m: AgentMessage) => m.role === "assistant")
    expect(assistants).toHaveLength(2)
    // Prompt + exactly one continue nudge.
    const nudges = starts.filter((m) => (m.content as string).includes("Continue generating"))
    expect(nudges).toHaveLength(1)
  }, 15000)

  it("caps continuations at 3 for a never-ending answer", async () => {
    const session = new Session()
    await runAgentLoop("list everything", {
      provider: sequencingProvider(["length", "length", "length", "length", "length"]),
      tools: [],
      session,
      config: { ...cfg2, maxLengthContinuations: 3 },
      emit: async () => {},
    })
    const assistants = session.messages.filter((m: AgentMessage) => m.role === "assistant")
    expect(assistants).toHaveLength(4)
    const nudges = session.messages.filter(
      (m: AgentMessage) => m.role === "user" && (m.content as string).includes("Continue generating"),
    )
    expect(nudges).toHaveLength(3)
  }, 15000)
})
