/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Desktop bridge contract: streaming mapping, single-flight send,
 * cancel-aborts-the-run, workspace switching, and terminal done events —
 * all without Electron (the bridge has no electron imports on purpose).
 */

import { describe, expect, it } from "vitest"
import { createAgentBridge, type BridgeAgent, type BridgeEvent } from "./bridge.js"

type RunImpl = (prompt: string, emit: (event: unknown) => void, signal?: AbortSignal) => Promise<unknown>

function scriptedAgent(runImpl: RunImpl): BridgeAgent {
  return { run: runImpl }
}

function collectingBridge(runImpl: RunImpl): {
  bridge: ReturnType<typeof createAgentBridge>
  events: BridgeEvent[]
  created: string[]
} {
  const events: BridgeEvent[] = []
  const created: string[] = []
  const bridge = createAgentBridge({
    onEvent: (event) => events.push(event),
    createAgent: async (cwd) => {
      created.push(cwd)
      return scriptedAgent(runImpl)
    },
  })
  return { bridge, events, created }
}

describe("desktop agent bridge", () => {
  it("streams text, thinking, and tool events, then a terminal done", async () => {
    const { bridge, events } = collectingBridge((_prompt, emit) => {
      emit({ type: "message_update", delta: { text: "Hel" } })
      emit({ type: "message_update", delta: { text: "lo" } })
      emit({ type: "message_update", delta: { thinking: "hmm" } })
      emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash" })
      emit({
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "bash",
        isError: false,
        result: { content: [{ type: "text", text: "ls output" }] },
      })
      emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "end_turn" } })
      return Promise.resolve()
    })

    await bridge.send("go")

    expect(events).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "thinking", text: "hmm" },
      { type: "tool_start", id: "c1", name: "bash" },
      { type: "tool_end", id: "c1", name: "bash", isError: false, output: "ls output" },
      { type: "done", stopReason: "end_turn" },
    ])
    expect(bridge.busy()).toBe(false)
  })

  it("forwards an error message_end's text and finishes with done/error", async () => {
    const { bridge, events } = collectingBridge((_prompt, emit) => {
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "provider exploded" }],
          stopReason: "error",
        },
      })
      return Promise.resolve()
    })

    await bridge.send("go")

    // Error text never streams as chunks — the message_end mapping is
    // the only path that surfaces it (same rule as the ACP server).
    expect(events).toEqual([
      { type: "text", text: "provider exploded" },
      { type: "done", stopReason: "error" },
    ])
  })

  it("cancel aborts the in-flight run and reports done/cancelled", async () => {
    let aborted = false
    const { bridge, events } = collectingBridge((_prompt, emit, signal) => {
      return new Promise<void>((resolve) => {
        const finish = (): void => {
          aborted = true
          emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } })
          resolve()
        }
        // Cancel may land before the run starts (during agent creation),
        // in which case the signal arrives already aborted.
        if (signal?.aborted === true) finish()
        else signal?.addEventListener("abort", finish)
      })
    })

    const sending = bridge.send("go")
    expect(bridge.busy()).toBe(true) // busy from the synchronous claim, not after creation
    bridge.cancel()
    await sending

    expect(aborted).toBe(true)
    expect(events).toEqual([{ type: "done", stopReason: "cancelled" }])
    expect(bridge.busy()).toBe(false)
  })

  it("rejects a second send while one is in flight (single-flight)", async () => {
    let release: (() => void) | undefined
    const { bridge } = collectingBridge(() => new Promise<void>((resolve) => (release = resolve)))

    const first = bridge.send("one")
    // `inFlight` is claimed synchronously — no yield needed before the
    // racing second send is judged.
    await expect(bridge.send("two")).rejects.toThrow("already in flight")

    if (release === undefined) throw new Error("run was never invoked")
    release()
    await first
    expect(bridge.busy()).toBe(false)
  })

  it("drops the cached agent when the workspace changes", async () => {
    const { bridge, created } = collectingBridge(() => Promise.resolve())
    bridge.setWorkspace("/w-a")
    await bridge.send("one")
    await bridge.send("two") // same workspace — cached, no re-create
    bridge.setWorkspace("/w-b")
    await bridge.send("three")

    expect(created).toEqual(["/w-a", "/w-b"])
    expect(bridge.workspace()).toBe("/w-b")
  })

  it("surfaces a thrown run as error + done/error", async () => {
    const { bridge, events } = collectingBridge(() => Promise.reject(new Error("kaput")))

    await bridge.send("go")

    expect(events).toEqual([
      { type: "error", message: "kaput" },
      { type: "done", stopReason: "error" },
    ])
    expect(bridge.busy()).toBe(false)
  })

  it("rejects an empty prompt before touching the agent factory", async () => {
    const { bridge, created } = collectingBridge(() => Promise.resolve())

    await expect(bridge.send("   \n  ")).rejects.toThrow("empty prompt")
    expect(created).toHaveLength(0)
  })
})
