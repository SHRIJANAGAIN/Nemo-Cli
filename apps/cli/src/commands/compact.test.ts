/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"

import { SessionCompaction, sessionCompaction } from "../session/session-compaction.js"
import { compactCommand } from "./compact.js"

/**
 * compactCommand is a thin CLI over the in-memory `sessionCompaction` singleton
 * (defaults 100000/80000/10) — no disk, no home directory, no config file, so
 * a plain static import is safe. The singleton is never mutated here; class
 * behaviour that needs different settings is exercised on fresh instances.
 */

/** 12 identical messages, each 33 chars = ceil(33/4) = 9 estimated tokens. */
const MULTI_SENTENCE = "One. Two. Three. Four. Five. Six."
const MESSAGES = Array.from({ length: 12 }, () => ({ content: MULTI_SENTENCE }))

describe("compactCommand config", () => {
  it("prints the singleton defaults", () => {
    expect(compactCommand({ action: "config" })).toBe(
      "Compaction config:\n  maxTokens: 100000\n  targetTokens: 80000\n  preserveRecent: 10",
    )
  })
})

describe("compactCommand estimate", () => {
  it("defaults both counters to zero and reports 'no'", () => {
    expect(compactCommand({ action: "estimate" })).toBe("Messages: 0, Tokens: 0\nShould compact: no")
  })

  it("trips exactly when tokens exceed maxTokens (100000)", () => {
    expect(compactCommand({ action: "estimate", messageCount: 3, totalTokens: 100000 })).toBe(
      "Messages: 3, Tokens: 100000\nShould compact: no",
    )
    expect(compactCommand({ action: "estimate", messageCount: 3, totalTokens: 100001 })).toBe(
      "Messages: 3, Tokens: 100001\nShould compact: yes",
    )
  })

  it("reaches the same decision regardless of messageCount — only tokens decide", () => {
    const few = compactCommand({ action: "estimate", messageCount: 1, totalTokens: 5 })
    const many = compactCommand({ action: "estimate", messageCount: 9999, totalTokens: 5 })

    // The line echoes the count it was given…
    expect(few).toBe("Messages: 1, Tokens: 5\nShould compact: no")
    expect(many).toBe("Messages: 9999, Tokens: 5\nShould compact: no")
    // …but the decision line is identical: messageCount never trips compaction.
    expect(few.split("\n")[1]).toBe(many.split("\n")[1])
  })
})

describe("compactCommand run", () => {
  it("compacts an empty message list to nothing", () => {
    expect(compactCommand({ action: "run" })).toBe(
      "Compaction result: compressed=false, originalTokens=0, compressedTokens=0, preserved=0",
    )
  })

  it("ignores messageCount/totalTokens — run has no message source and always compacts []", () => {
    expect(compactCommand({ action: "run", messageCount: 12, totalTokens: 99999 })).toBe(
      "Compaction result: compressed=false, originalTokens=0, compressedTokens=0, preserved=0",
    )
  })
})

describe("compactCommand reset", () => {
  it("reports a reset without altering the config", () => {
    expect(compactCommand({ action: "reset" })).toBe("Compaction state reset")
    expect(sessionCompaction.getConfig()).toEqual({
      maxTokens: 100000,
      targetTokens: 80000,
      preserveRecent: 10,
    })
  })
})

describe("compactCommand unknown action", () => {
  it("reports the unhandled action name", () => {
    expect(compactCommand({ action: "bogus" as never })).toBe("Unknown compact action: bogus")
  })
})

describe("SessionCompaction class", () => {
  it("estimateTokens is ceil(length / 4)", () => {
    const c = new SessionCompaction()

    expect(c.estimateTokens("")).toBe(0)
    expect(c.estimateTokens("1234")).toBe(1)
    expect(c.estimateTokens("12345")).toBe(2)
    expect(c.estimateTokens("a".repeat(9))).toBe(3)
  })

  it("setConfig merges partial overrides over the defaults", () => {
    const c = new SessionCompaction()

    expect(c.setConfig({ maxTokens: 50 })).toBeUndefined()
    expect(c.getConfig()).toEqual({ maxTokens: 50, targetTokens: 80000, preserveRecent: 10 })

    expect(c.shouldCompact(1, 50)).toBe(false)
    expect(c.shouldCompact(1, 51)).toBe(true)
  })

  it("leaves a list shorter than preserveRecent untouched (nothing to compress)", () => {
    const c = new SessionCompaction()
    const result = c.compact(MESSAGES.slice(0, 3))

    expect(result).toEqual({
      compressed: false,
      originalTokens: 27,
      compressedTokens: 27,
      preservedMessages: 3,
    })
  })

  it("uses explicit per-message token counts when provided", () => {
    const c = new SessionCompaction()
    const result = c.compact([
      { content: "a".repeat(400), tokens: 1000 },
      ...Array.from({ length: 10 }, (_, i) => ({ content: `msg-${i}`, tokens: 10 })),
    ])

    expect(result.originalTokens).toBe(1000 + 100)
    // 11 messages: the first is "older" (summarized), newest 10 preserved.
    expect(result.preservedMessages).toBe(10)
    expect(result.compressedTokens).toBeLessThan(result.originalTokens)
    expect(result.compressed).toBe(true)
  })
})
