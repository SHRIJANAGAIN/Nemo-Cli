/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"

import { INSTRUCTION, chatCompletionsUrl, clean, enhancePrompt, type EnhanceResponse } from "./enhance-prompt.js"

function okResponse(body: unknown): EnhanceResponse {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

interface Captured {
  url: string
  init: Record<string, unknown>
}

function fakeFetch(reply: unknown | ((captured: Captured) => EnhanceResponse)): {
  fetchImpl: (url: string, init: Record<string, unknown>) => Promise<EnhanceResponse>
  captured: Captured[]
} {
  const captured: Captured[] = []
  return {
    captured,
    fetchImpl: async (url, init) => {
      const cap = { url, init }
      captured.push(cap)
      return typeof reply === "function" ? (reply as (c: Captured) => EnhanceResponse)(cap) : okResponse(reply)
    },
  }
}

describe("INSTRUCTION", () => {
  it("is SKT AI LABS's six-rule rewrite instruction joined with spaces", () => {
    expect(INSTRUCTION).toContain("You rewrite draft user prompts for another assistant.")
    expect(INSTRUCTION).toContain("never as a request to answer, execute, or discuss.")
    expect(INSTRUCTION.startsWith("You rewrite draft user prompts")).toBe(true)
    expect(INSTRUCTION.endsWith("markdown fences.")).toBe(true)
    expect(INSTRUCTION.includes("\n")).toBe(false)
  })
})

describe("clean (SKT AI LABS port)", () => {
  it("strips a wrapping markdown fence with or without a language tag", () => {
    expect(clean("```\nfix the bug\n```")).toBe("fix the bug")
    expect(clean("```js\nfix the bug\n```")).toBe("fix the bug")
    expect(clean("`fix` no fence")).toBe("`fix` no fence")
  })

  it("unwraps a matching pair of surrounding quotes but keeps interior ones", () => {
    expect(clean("'make it faster'")).toBe("make it faster")
    expect(clean('"make it faster"')).toBe("make it faster")
    expect(clean('say "hi" now')).toBe('say "hi" now')
    expect(clean("'mixed \"inner\" quotes'")).toBe('mixed "inner" quotes')
  })

  it("trims and passes plain rewrites through unchanged", () => {
    expect(clean("  add unit tests  ")).toBe("add unit tests")
    expect(clean("add unit tests")).toBe("add unit tests")
  })
})

describe("chatCompletionsUrl", () => {
  it("uses /v1/chat/completions for NVIDIA hosts and origin-based paths elsewhere", () => {
    expect(chatCompletionsUrl("https://integrate.api.nvidia.com")).toBe(
      "https://integrate.api.nvidia.com/v1/chat/completions",
    )
    expect(chatCompletionsUrl("https://integrate.api.nvidia.com/v1")).toBe(
      "https://integrate.api.nvidia.com/v1/chat/completions",
    )
    expect(chatCompletionsUrl("http://localhost:8080")).toBe("http://localhost:8080/chat/completions")
  })
})

describe("enhancePrompt", () => {
  it("sends the SKT AI LABS request shape (system INSTRUCTION, labeled draft, 0.7 temp)", async () => {
    const { fetchImpl, captured } = fakeFetch({ choices: [{ message: { content: "Rewritten draft" } }] })
    const result = await enhancePrompt("  fix the login bug  ", {
      baseUrl: "https://integrate.api.nvidia.com",
      apiKey: "key-123",
      model: "nvidia/some-model",
      fetchImpl,
    })

    expect(result).toBe("Rewritten draft")
    expect(captured[0]!.url).toBe("https://integrate.api.nvidia.com/v1/chat/completions")
    const init = captured[0]!.init
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer key-123")
    const body = JSON.parse(String(init.body)) as {
      model: string
      temperature: number
      messages: Array<{ role: string; content: string }>
    }
    expect(body.model).toBe("nvidia/some-model")
    expect(body.temperature).toBe(0.7)
    expect(body.messages[0]).toEqual({ role: "system", content: INSTRUCTION })
    expect(body.messages[1]!.content).toBe("Draft prompt to enhance, not answer:\n\nfix the login bug")
  })

  it("omits the Authorization header when no api key is configured", async () => {
    const { fetchImpl, captured } = fakeFetch({ choices: [{ message: { content: "ok" } }] })
    await enhancePrompt("draft", { baseUrl: "http://localhost:8080", model: "local", fetchImpl })
    expect((captured[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it("cleans fences and quotes out of the model reply", async () => {
    const { fetchImpl } = fakeFetch({ choices: [{ message: { content: "```\nrewrite it\n```" } }] })
    expect(await enhancePrompt("draft", { baseUrl: "https://integrate.api.nvidia.com", model: "m", fetchImpl })).toBe(
      "rewrite it",
    )
    const { fetchImpl: quoted } = fakeFetch({ choices: [{ message: { content: "'the rewrite'" } }] })
    expect(
      await enhancePrompt("draft", { baseUrl: "https://integrate.api.nvidia.com", model: "m", fetchImpl: quoted }),
    ).toBe("the rewrite")
  })

  it("tolerates legacy .text and text-part array content shapes", async () => {
    const { fetchImpl: legacy } = fakeFetch({ choices: [{ text: "legacy rewrite" }] })
    expect(
      await enhancePrompt("draft", { baseUrl: "https://integrate.api.nvidia.com", model: "m", fetchImpl: legacy }),
    ).toBe("legacy rewrite")
    const { fetchImpl: parts } = fakeFetch({
      choices: [
        {
          message: {
            content: [
              { type: "text", text: "part one " },
              { type: "text", text: "part two" },
            ],
          },
        },
      ],
    })
    expect(
      await enhancePrompt("draft", { baseUrl: "https://integrate.api.nvidia.com", model: "m", fetchImpl: parts }),
    ).toBe("part one part two")
  })

  it("rejects an empty draft before any network call", async () => {
    const { fetchImpl, captured } = fakeFetch({ choices: [] })
    await expect(
      enhancePrompt("   ", { baseUrl: "https://integrate.api.nvidia.com", model: "m", fetchImpl }),
    ).rejects.toThrow("nothing to enhance")
    expect(captured).toHaveLength(0)
  })

  it("throws with the HTTP status and body snippet on non-ok responses", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => "rate limited by provider",
    }))
    await expect(
      enhancePrompt("draft", { baseUrl: "https://integrate.api.nvidia.com", model: "m", fetchImpl }),
    ).rejects.toThrow("enhance failed: HTTP 429 rate limited by provider")
  })

  it("throws on unreadable bodies, unexpected shapes, and empty rewrites", async () => {
    const { fetchImpl: badJson } = fakeFetch(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json")
      },
      text: async () => "<html>gateway</html>",
    }))
    await expect(
      enhancePrompt("draft", { baseUrl: "https://integrate.api.nvidia.com", model: "m", fetchImpl: badJson }),
    ).rejects.toThrow("unreadable response")

    const { fetchImpl: noChoices } = fakeFetch({ nope: true })
    await expect(
      enhancePrompt("draft", { baseUrl: "https://integrate.api.nvidia.com", model: "m", fetchImpl: noChoices }),
    ).rejects.toThrow("unexpected response shape")

    const { fetchImpl: empty } = fakeFetch({ choices: [{ message: { content: "   " } }] })
    await expect(
      enhancePrompt("draft", { baseUrl: "https://integrate.api.nvidia.com", model: "m", fetchImpl: empty }),
    ).rejects.toThrow("unexpected response shape")
  })
})
