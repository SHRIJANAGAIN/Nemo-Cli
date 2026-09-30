/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, it, expect, vi } from "vitest"
import { TrayambakClient } from "./index.js"

// startThread dynamically imports apps/runtime, which boots a REAL agent:
// ambient config (home/project/model env) drives a live model call and
// writes transcript files under ~/.trayambak/sessions. None of that belongs
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

describe("TrayambakClient (SDK)", () => {
  it("constructs without throwing", () => {
    expect(() => new TrayambakClient()).not.toThrow()
  })

  it("startThread returns a thread handle with an id and events array", async () => {
    const client = new TrayambakClient()
    const thread = await client.startThread("test prompt")
    expect(typeof thread.id).toBe("string")
    expect(Array.isArray(thread.events)).toBe(true)
  })
})
