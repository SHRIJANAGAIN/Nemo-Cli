/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Prompt-cache breakpoints (#123).
 *
 * An agent turn re-sends the same prefix every time: system prompt, tool
 * schemas, and the entire conversation so far. Without a cache breakpoint the
 * provider bills that whole prefix again on every request, which is the single
 * largest cost of a long session.
 *
 * Two provider shapes, one policy:
 *  - Anthropic marks a prefix with `cache_control: {type:"ephemeral"}`.
 *  - OpenAI-compatible has no marker; caching is implicit and routed by
 *    `prompt_cache_key`, so the only lever is a STABLE per-session key.
 *
 * The detail that silently breaks naive implementations: a breakpoint must sit
 * BEFORE anything that changes every turn. Marking a block that is rewritten
 * each request invalidates the whole prefix and is worse than not caching.
 */
import { describe, expect, it } from "vitest"
import {
  ANTHROPIC_TAIL_BREAKPOINTS,
  buildPromptCacheKey,
  markAnthropicCacheBreakpoints,
  systemWithCacheControl,
  withPromptCacheKey,
} from "./prompt-cache.js"
import type { CacheableMessage } from "./prompt-cache.js"

describe("systemWithCacheControl", () => {
  it("converts the system string into a cacheable block", () => {
    const blocks = systemWithCacheControl("you are a helpful agent")
    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks).toEqual([{ type: "text", text: "you are a helpful agent", cache_control: { type: "ephemeral" } }])
  })

  it("returns nothing for an empty system prompt so no empty block is sent", () => {
    expect(systemWithCacheControl("")).toBeUndefined()
    expect(systemWithCacheControl("   \n  ")).toBeUndefined()
  })

  it("keeps a caller-supplied cache type instead of forcing ephemeral", () => {
    const blocks = systemWithCacheControl("sys", "ttl5m") as Array<Record<string, unknown>> | undefined
    expect(blocks?.[0]?.cache_control).toEqual({ type: "ttl5m" })
  })
})

describe("markAnthropicCacheBreakpoints", () => {
  const convo: CacheableMessage[] = [
    { role: "user", content: "first" },
    { role: "assistant", content: "second" },
    { role: "user", content: "third" },
    { role: "assistant", content: "fourth" },
    { role: "user", content: "fifth" },
  ]

  it("marks only the trailing window, not the whole conversation", () => {
    const marked = markAnthropicCacheBreakpoints(convo)
    const flagged = marked.filter((m) => m.cache_control !== undefined)
    expect(flagged).toHaveLength(ANTHROPIC_TAIL_BREAKPOINTS)
    // The oldest messages stay unmarked: they are inside the prefix the
    // trailing breakpoint already covers, and marking them adds nothing.
    expect(marked[0]?.cache_control).toBeUndefined()
  })

  it("ends the window on the newest message so the next turn is a cache hit", () => {
    const marked = markAnthropicCacheBreakpoints(convo)
    const last = marked[marked.length - 1]
    expect(last?.cache_control).toEqual({ type: "ephemeral" })
  })

  it("never mutates the caller's messages", () => {
    const original = convo.map((m) => ({ ...m }))
    markAnthropicCacheBreakpoints(convo)
    expect(convo).toEqual(original)
    expect(original.every((m) => m.cache_control === undefined)).toBe(true)
  })

  it("marks every message when the conversation is shorter than the window", () => {
    const short: CacheableMessage[] = [
      { role: "user", content: "only" },
      { role: "assistant", content: "reply" },
    ]
    const marked = markAnthropicCacheBreakpoints(short)
    expect(marked.filter((m) => m.cache_control !== undefined).length).toBe(short.length)
  })

  it("handles an empty conversation without inventing a breakpoint", () => {
    expect(markAnthropicCacheBreakpoints([])).toEqual([])
  })
})

describe("buildPromptCacheKey", () => {
  const tools = [
    {
      name: "read_file",
      description: "read",
      timeoutMs: 1000,
      parameters: { type: "object" as const, properties: {}, required: [] },
    },
  ]

  it("is stable across turns when the prefix is unchanged", () => {
    const a = buildPromptCacheKey("system v1", tools)
    const b = buildPromptCacheKey("system v1", tools)
    expect(a).toBe(b)
    expect(a).toMatch(/^[a-f0-9]{16}$/)
  })

  it("changes when the system prompt changes so a config edit misses cleanly", () => {
    expect(buildPromptCacheKey("system v1", tools)).not.toBe(buildPromptCacheKey("system v2", tools))
  })

  it("changes when the tool schemas change", () => {
    const more = [
      ...tools,
      {
        name: "write_file",
        description: "write",
        timeoutMs: 1000,
        parameters: { type: "object" as const, properties: {}, required: [] },
      },
    ]
    expect(buildPromptCacheKey("system v1", tools)).not.toBe(buildPromptCacheKey("system v1", more))
  })

  it("ignores conversation content so one session does not thrash its own key", () => {
    // The key routes the PREFIX, not the transcript. Folding messages in would
    // change the key every single turn and guarantee a miss.
    const first = buildPromptCacheKey("sys", tools, "user said one thing")
    const later = buildPromptCacheKey("sys", tools, "user said something else entirely")
    expect(first).toBe(later)
  })

  it("survives absent tools without throwing", () => {
    expect(buildPromptCacheKey("sys", undefined)).toMatch(/^[a-f0-9]{16}$/)
  })
})

describe("withPromptCacheKey", () => {
  it("adds the key to an OpenAI-compatible body", () => {
    const body = withPromptCacheKey({ model: "m", messages: [] }, "abc123")
    expect(body.prompt_cache_key).toBe("abc123")
    expect(body.model).toBe("m")
  })

  it("leaves the body untouched when there is no key", () => {
    const input = { model: "m", messages: [] }
    expect(withPromptCacheKey(input, undefined)).toEqual(input)
  })

  it("does not invent a key when caching is turned off", () => {
    const input = { model: "m", messages: [] }
    expect(withPromptCacheKey(input, "")).toEqual(input)
  })
})
