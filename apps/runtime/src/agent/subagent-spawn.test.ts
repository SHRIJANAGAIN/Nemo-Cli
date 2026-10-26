/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Subagent spawning, end to end: the nemo__Agent tool call runs a REAL
 * child loop (fresh Session, parent's provider/config/emit, engine-owned
 * depth guard + lifecycle events), the parent session gains only the child's
 * summary result, children never see the spawn tools, and a depth-3 agent is
 * refused with `depth_limit_exceeded` before any level-4 loop starts.
 *
 * Zero network: a scripted mock Provider answers every chat call.
 */

import { afterEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Agent } from "./agent.js"
import type { NemoConfig } from "../config.js"
import type { AssistantMessage, TaggedAgentEvent } from "../../../../packages/protocol/src/index.js"
import type { ChatInput, Provider } from "../../../../packages/provider/src/index.js"

type MockProvider = Provider & { readonly calls: ChatInput[] }

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-spawn-"))
  tempDirs.push(dir)
  return dir
}

const tempDirs: string[] = []

afterEach(() => {
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

function firstUserText(input: ChatInput): string {
  const user = input.messages.find((m) => m.role === "user")
  return user && typeof user.content === "string" ? user.content : ""
}

/**
 * Scripted provider: `respond(firstUserPrompt, perSessionCallIndex)` decides
 * each reply. Per-session indexing means a parent that delegated once gets a
 * plain answer on its next call instead of delegating forever.
 */
function scriptedProvider(respond: (firstUser: string, callIndex: number) => AssistantMessage): MockProvider {
  const calls: ChatInput[] = []
  const perSession = new Map<string, number>()
  return {
    id: "mock",
    calls,
    async chat(input: ChatInput): Promise<AssistantMessage> {
      const first = firstUserText(input)
      const index = perSession.get(first) ?? 0
      perSession.set(first, index + 1)
      calls.push(input)
      return respond(first, index)
    },
  }
}

let callSeq = 0
const textMsg = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "end_turn",
})
const agentCallMsg = (prompt: string, extra: Record<string, unknown> = {}): AssistantMessage => {
  callSeq++
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: `call-${callSeq}`,
        name: "nemo__Agent",
        arguments: { description: "spawned task", prompt, ...extra },
      },
    ],
    stopReason: "tool_use",
  }
}
const readFileCallMsg = (filePath: string): AssistantMessage => {
  callSeq++
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: `call-${callSeq}`,
        name: "read_file",
        arguments: { path: filePath },
      },
    ],
    stopReason: "tool_use",
  }
}

function toolMessages(agent: Agent): Array<{ content: string; isError: boolean }> {
  return agent.session.messages
    .filter((m) => m.role === "tool")
    .map((m) => ({
      content: m.role === "tool" ? m.content.map((p) => ("text" in p ? p.text : "")).join("") : "",
      isError: m.role === "tool" ? m.isError : false,
    }))
}

describe("subagent spawn (real child loop via nemo__Agent)", () => {
  it("runs a real child loop and folds only the child's summary into the parent session", async () => {
    const cwd = tempDir()
    fs.writeFileSync(path.join(cwd, "note.txt"), "hello from the workspace")
    const provider = scriptedProvider((first, index) => {
      if (first.startsWith("PARENT") && index === 0) return agentCallMsg("CHILD: report the weather")
      // The child reads a real workspace file, then answers — the tool
      // call proves the nested loop executes tools, not just chat.
      if (first.startsWith("CHILD") && index === 0) return readFileCallMsg("note.txt")
      if (first.startsWith("CHILD")) return textMsg("child final answer")
      return textMsg("parent done")
    })
    const agent = await Agent.create({ config: makeConfig(cwd), provider })
    const events: TaggedAgentEvent[] = []
    await agent.run("PARENT: delegate this", (e) => {
      events.push(e)
    })

    // ≥2 provider calls across parent + child; the child ran its own session.
    expect(provider.calls.length).toBeGreaterThanOrEqual(2)
    const childCalls = provider.calls.filter((c) => firstUserText(c).startsWith("CHILD"))
    expect(childCalls.length).toBeGreaterThanOrEqual(1)
    // The child's tool result flowed back into ITS session (read_file on
    // the workspace), never into the parent's transcript.
    const lastChild = childCalls[childCalls.length - 1]
    const childToolResults = (lastChild?.messages ?? []).filter((m) => m.role === "tool")
    expect(childToolResults.length).toBeGreaterThan(0)
    expect(childToolResults.some((m) => String(m.content ?? "").includes("hello from the workspace"))).toBe(true)

    // Child tools = parent's tools minus the spawn tools (bounded fan-out),
    // while the parent still offers nemo__Agent.
    const parentToolNames = (provider.calls[0]?.tools ?? []).map((d) => d.name)
    expect(parentToolNames).toContain("nemo__Agent")
    const childToolNames = (childCalls[0]?.tools ?? []).map((d) => d.name)
    expect(childToolNames).toContain("bash")
    expect(childToolNames).not.toContain("nemo__Agent")
    expect(childToolNames).not.toContain("nemo__RunTeam")
    expect(childToolNames).not.toContain("nemo__ParallelReview")
    expect(childToolNames).not.toContain("nemo__ParallelExecute")

    // Parent session gains ONLY the child's summary result: user →
    // assistant(toolCall) → tool(result = summary) → assistant(final).
    const messages = agent.session.messages
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"])
    const users = messages.filter((m) => m.role === "user")
    expect(users).toHaveLength(1)
    expect(users[0]?.role === "user" && users[0].content).toBe("PARENT: delegate this")
    const tools = toolMessages(agent)
    expect(tools).toHaveLength(1)
    expect(tools[0].isError).toBe(false)
    expect(tools[0].content).toContain("child final answer")

    // Protocol lifecycle events, emitted by the core engine.
    expect(events.some((e) => e.type === "subagent_start")).toBe(true)
    expect(
      events.some((e) => e.type === "subagent_start" && e.name === "spawned task" && e.subagentType === "general"),
    ).toBe(true)
    expect(events.some((e) => e.type === "subagent_end" && e.result === "child final answer")).toBe(true)

    // Child loop events are tagged with the subagent id for UI routing.
    const tagged = events.filter((e) => e.type === "message_end" && e.subagentId !== undefined)
    const start = events.find((e) => e.type === "subagent_start")
    expect(tagged.length).toBeGreaterThan(0)
    expect(tagged[0]?.subagentId).toBe(start?.subagentId)

    // The child's own tool run (read_file on the workspace) completed
    // successfully and streamed back under its subagent tag.
    const childToolEnds = events.filter(
      (e) =>
        e.type === "tool_execution_end" &&
        e.toolName === "read_file" &&
        e.subagentId !== undefined &&
        e.subagentId === start?.subagentId &&
        e.isError === false,
    )
    expect(childToolEnds.length).toBeGreaterThan(0)

    // Usage summary accumulated through the engine.
    const usage = agent.subagentUsage()
    expect(usage.turns).toBeGreaterThanOrEqual(1)
    expect(usage.toolCalls).toBeGreaterThanOrEqual(1)
    expect(usage.durationMs).toBeGreaterThanOrEqual(0)
  }, 60_000)

  it("blocks a 4th nesting level with a structured depth_limit_exceeded outcome", async () => {
    const provider = scriptedProvider((first, index) => {
      if (first.startsWith("DEEP") && index === 0) return agentCallMsg("LEVEL4: spawn deeper")
      return textMsg("deep done")
    })
    // An agent at depth 3 IS the 4th nesting level: its spawn would be
    // child depth 4 > maxDepth 3 and must be refused before any child loop.
    const agent = await Agent.create({ config: makeConfig(tempDir()), provider, subagentDepth: 3 })
    const events: TaggedAgentEvent[] = []
    await agent.run("DEEP: keep nesting", (e) => {
      events.push(e)
    })

    const tools = toolMessages(agent)
    expect(tools).toHaveLength(1)
    expect(tools[0].isError).toBe(true)
    expect(tools[0].content).toContain("depth_limit_exceeded")

    // No level-4 session ever reached the provider; the parent loop survived.
    expect(provider.calls.some((c) => firstUserText(c).startsWith("LEVEL4"))).toBe(false)
    expect(provider.calls).toHaveLength(2)
    expect(events.some((e) => e.type === "subagent_start")).toBe(false)
    expect(agent.subagentUsage()).toEqual({ turns: 0, toolCalls: 0, durationMs: 0 })
  }, 60_000)

  it("returns a subagentId immediately for background tasks and completes later", async () => {
    const provider = scriptedProvider((first, index) => {
      if (first.startsWith("BG") && index === 0) return agentCallMsg("BGCHILD: long task", { background: true })
      if (first.startsWith("BGCHILD")) return textMsg("bg child result")
      return textMsg("parent done")
    })
    const agent = await Agent.create({ config: makeConfig(tempDir()), provider })
    const events: TaggedAgentEvent[] = []
    await agent.run("BG: delegate in background", (e) => {
      events.push(e)
    })

    // The tool returned WITHOUT waiting for the child.
    const tools = toolMessages(agent)
    expect(tools).toHaveLength(1)
    expect(tools[0].content).toContain("started in background (id:")
    const idMatch = tools[0].content.match(/id: ([0-9a-f-]{36})/)
    expect(idMatch).not.toBeNull()
    const subagentId = idMatch?.[1] ?? ""
    expect(subagentId).toBeTruthy()

    // Engine background registry: poll until the detached child finishes.
    const deadline = Date.now() + 15_000
    while (agent.getBackgroundJob(subagentId)?.status !== "completed" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(agent.getBackgroundJob(subagentId)).toMatchObject({
      status: "completed",
      output: "bg child result",
      name: "spawned task",
    })
    expect(agent.listBackgroundJobs()).toHaveLength(1)
    expect(agent.isBackgroundJobRunning(subagentId)).toBe(false)

    expect(events.some((e) => e.type === "subagent_background_start")).toBe(true)
    expect(events.some((e) => e.type === "subagent_background_end" && e.result === "bg child result")).toBe(true)
    expect(agent.subagentUsage().turns).toBeGreaterThanOrEqual(1)
  }, 60_000)
})
