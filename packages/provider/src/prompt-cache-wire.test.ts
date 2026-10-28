/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Wire-level proof that the cache markers actually reach the request body (#123).
 *
 * `prompt-cache.test.ts` covers the policy in isolation; this file asserts the
 * providers really call it, because a correct helper that nothing invokes is
 * the usual way this kind of optimisation silently stops existing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NvidiaProvider, promptCacheKeyAllowed } from "./nvidia.js"
import type { ChatInput } from "./types.js"

afterEach(() => {
  vi.unstubAllEnvs()
})

const baseOptions = { baseUrl: "http://127.0.0.1:1/v1", model: "test-model", maxTokens: 1024 }

const convo: ChatInput["messages"] = [
  { role: "user", content: "first question" },
  { role: "assistant", content: "first answer" },
  { role: "user", content: "second question" },
]

function nvidiaBody(input: ChatInput): Record<string, unknown> {
  const provider = new NvidiaProvider(baseOptions) as unknown as { buildBody(i: ChatInput): Record<string, unknown> }
  return provider.buildBody(input)
}

function nvidiaBodyAt(baseUrl: string, input: ChatInput): Record<string, unknown> {
  const provider = new NvidiaProvider({ ...baseOptions, baseUrl }) as unknown as {
    buildBody(i: ChatInput): Record<string, unknown>
  }
  return provider.buildBody(input)
}

describe("NvidiaProvider prompt cache key on the wire", () => {
  // The key mechanics below are pinned with the operator opt-in active; the
  // default-off behavior is pinned in the next block.
  beforeEach(() => {
    vi.stubEnv("NEMO_PROMPT_CACHE_KEY_ENABLED", "1")
  })

  it("attaches a stable key derived from the prefix", () => {
    const body = nvidiaBody({ system: "SYSTEM", messages: convo, tools: [] })
    expect(typeof body.prompt_cache_key).toBe("string")
    expect(body.prompt_cache_key).toMatch(/^[a-f0-9]{16}$/)
  })

  it("keeps the key IDENTICAL across turns of the same session", () => {
    const turn1 = nvidiaBody({ system: "SYSTEM", messages: convo })
    const turn2 = nvidiaBody({
      system: "SYSTEM",
      messages: [...convo, { role: "assistant", content: "a2" }, { role: "user", content: "q3" }],
    })
    expect(turn2.prompt_cache_key).toBe(turn1.prompt_cache_key)
  })

  it("changes the key when the tool schemas change", () => {
    const noTools = nvidiaBody({ system: "SYSTEM", messages: convo })
    const withTools = nvidiaBody({
      system: "SYSTEM",
      messages: convo,
      tools: [
        {
          name: "read_file",
          description: "read",
          timeoutMs: 1000,
          parameters: { type: "object", properties: {}, required: [] },
        },
      ],
    })
    expect(withTools.prompt_cache_key).not.toBe(noTools.prompt_cache_key)
  })

  it("does not disturb the rest of the body", () => {
    const body = nvidiaBody({ system: "SYSTEM", messages: convo })
    expect(body.model).toBe("test-model")
    expect(body.stream).toBe(true)
    expect(Array.isArray(body.messages)).toBe(true)
    expect((body.messages as unknown[])[0]).toEqual({ role: "system", content: "SYSTEM" })
  })
})

describe("promptCacheKeyAllowed (strict APIs strip the key by default)", () => {
  it("strips the key by default — NVIDIA cloud 400s it, strict gateways reject unknown args the same way", () => {
    // Opt-in explicitly OFF (empty string is falsy for the gate).
    vi.stubEnv("NEMO_PROMPT_CACHE_KEY_ENABLED", "")
    expect(promptCacheKeyAllowed()).toBe(false)
    // Observed live: `Validation: Unsupported parameter(s): prompt_cache_key`
    // killed every model routed through these hosts — and strict APIs
    // document the same 400 for unrecognized arguments.
    for (const baseUrl of [
      "https://integrate.api.nvidia.com/v1",
      "https://integrate.api.nvidia.com/v1/",
      "https://build.nvidia.com/v1",
      "http://127.0.0.1:1/v1",
    ]) {
      const body = nvidiaBodyAt(baseUrl, { system: "SYSTEM", messages: convo })
      expect(body.prompt_cache_key, baseUrl).toBeUndefined()
      // Everything else still ships: only the key is stripped.
      expect(body.model).toBe("test-model")
      expect(body.stream).toBe(true)
    }
  })

  it("restores the key on explicit operator opt-in", () => {
    vi.stubEnv("NEMO_PROMPT_CACHE_KEY_ENABLED", "1")
    expect(promptCacheKeyAllowed()).toBe(true)
    const body = nvidiaBodyAt("http://127.0.0.1:1/v1", { system: "SYSTEM", messages: convo })
    expect(typeof body.prompt_cache_key).toBe("string")
    expect(body.prompt_cache_key).toMatch(/^[a-f0-9]{16}$/)
  })
})
