/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect, vi } from "vitest"
import { NemoClient } from "./index.js"

// startThread dynamically imports apps/runtime, which boots a REAL agent:
// ambient config (home/project/model env) drives a live model call and
// writes transcript files under ~/.nemo/sessions. None of that belongs
// in a unit test — stub the runtime and the transcript backend so the
// handle-shape assertions stay deterministic and network-free.
vi.mock("../../../apps/runtime/src/index.js", () => ({
  Agent: class {
    async run(_prompt: string, emit: (event: unknown) => void): Promise<void> {
      emit({ type: "TurnEnd" })
    }
  },
  loadConfig: () => ({}),
}))
vi.mock("../../session-backends/src/transcript.js", () => ({
  createTranscript: () => ({ id: "sdk-test-thread" }),
  appendWire: () => undefined,
}))

describe("NemoClient (SDK)", () => {
  it("constructs without throwing", () => {
    expect(() => new NemoClient()).not.toThrow()
  })

  it("startThread returns a thread handle with an id and events array", async () => {
    const client = new NemoClient()
    const thread = await client.startThread("test prompt")
    expect(typeof thread.id).toBe("string")
    expect(Array.isArray(thread.events)).toBe(true)
  })
})
