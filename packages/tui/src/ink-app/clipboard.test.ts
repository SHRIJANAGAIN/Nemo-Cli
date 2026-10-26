/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { formatTranscript } from "./clipboard.js"
import type { NemoMessage } from "./types.js"

/** formatTranscript only — no real clipboard writes in unit tests. */

const user = (id: string, content: string): NemoMessage => ({
  id,
  timestamp: 0,
  role: "user",
  content,
})

const assistant = (id: string, content: string): NemoMessage => ({
  id,
  timestamp: 0,
  role: "assistant",
  content,
})

describe("formatTranscript", () => {
  it("labels blocks by role, in conversation order", () => {
    const text = formatTranscript([user("u1", "hello"), assistant("a1", "hi there")], "all")
    expect(text).toBe("You:\nhello\n\nAssistant:\nhi there")
  })

  it("includes tool-call args and results under a tool label", () => {
    const text = formatTranscript(
      [
        {
          id: "t1",
          timestamp: 0,
          role: "assistant",
          content: '{"path":"."}',
          toolName: "list_dir",
          toolCallId: "x1",
          toolStatus: "completed",
          result: "a.ts\nb.ts",
        },
      ],
      "all",
    )
    expect(text).toBe('Tool · list_dir:\n{"path":"."}\na.ts\nb.ts')
  })

  it('"last" returns only the newest assistant reply', () => {
    const text = formatTranscript(
      [user("u1", "q1"), assistant("a1", "first"), user("u2", "q2"), assistant("a2", "second")],
      "last",
    )
    expect(text).toBe("Assistant:\nsecond")
    expect(text).not.toContain("first")
    expect(text).not.toContain("q1")
  })

  it('returns "" when there is nothing to copy', () => {
    expect(formatTranscript([], "all")).toBe("")
    expect(formatTranscript([user("u1", "only a question")], "last")).toBe("")
    expect(formatTranscript([{ id: "s1", timestamp: 0, role: "system", content: "   " }], "all")).toBe("")
  })

  it("copies fenced content verbatim (no stair-strip — copy equals source)", () => {
    const body = "see:\n```diff\n context\n-old\n+new\n```"
    const text = formatTranscript([assistant("a1", body)], "all")
    expect(text).toBe("Assistant:\n" + body)
  })
})
