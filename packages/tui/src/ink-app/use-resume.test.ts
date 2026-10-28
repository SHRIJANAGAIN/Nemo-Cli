/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Resume contract for the TUI: a resumed conversation has to reach the AGENT
 * (session seeded + prompt rebuilt against the current long-term memory), not
 * only the screen, and `nemo resume <id>` has to read the transcript formats
 * that actually exist on disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

vi.mock("../../../../apps/runtime/src/tools/memory/memory.js", () => ({
  loadMemory: vi.fn(() => Array.from({ length: 3 }, (_, i) => ({ id: `m${i}`, content: `fact ${i}` }))),
}))

import { bootResume, seedAgentWith } from "./use-resume.js"
import type { NemoMessage } from "./types.js"

const row = (over: Partial<NemoMessage> & { role: NemoMessage["role"]; content: string }): NemoMessage =>
  ({ id: over.content, timestamp: 0, ...over }) as NemoMessage

/** Minimal stand-in for the real agent: only the session array and the prompt
 *  refresh are part of the resume contract. */
function fakeAgent(existing: unknown[] = []) {
  const messages = [...existing]
  const refresh = vi.fn()
  return {
    refresh,
    agent: {
      session: { messages, clear: () => messages.splice(0, messages.length) },
      refreshSystemPrompt: refresh,
    } as never,
  }
}

let file: string
beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nemo-resume-")), "wire.jsonl")
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("seedAgentWith", () => {
  it("replaces the agent session with the resumed transcript and re-ranks memory", () => {
    const { agent, refresh } = fakeAgent([{ role: "user", content: "leftover from the previous chat" }])

    seedAgentWith(agent, [
      row({ role: "system", content: "should never reach the agent" }),
      row({ role: "user", content: "does the user prefer pnpm" }),
      row({ role: "assistant", content: "checking the lockfile" }),
    ])

    expect(agent.session.messages).toHaveLength(2)
    expect(agent.session.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"])
    // The query is what the long-term memories are ranked against, so a resumed
    // chat gets the memories about ITS topic.
    expect(refresh).toHaveBeenCalledWith("does the user prefer pnpm checking the lockfile")
  })
})

describe("bootResume (`nemo resume <id>`)", () => {
  it("reads a JSONL wire transcript and reports the memories in context", () => {
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ ts: 1, message: { role: "system", content: "OLD PROMPT" } }),
        JSON.stringify({ ts: 2, message: { role: "user", content: "hello" } }),
        JSON.stringify({
          ts: 3,
          message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "end_turn" },
        }),
      ].join("\n"),
      "utf8",
    )

    const result = bootResume(file)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows.map((r) => r.role)).toEqual(["user", "assistant"])
    expect(result.memories).toBe(3)
  })

  it("says so when the transcript cannot be read", () => {
    fs.writeFileSync(file, "{ not json", "utf8")
    expect(bootResume(file)).toEqual({ ok: false, reason: "unreadable" })
    expect(bootResume(path.join(os.tmpdir(), "definitely-not-here-4471.jsonl"))).toEqual({
      ok: false,
      reason: "unreadable",
    })
  })
})
