/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"

import { TITLE_INSTRUCTION, generateChatTitle, toFiveWords, type AutoTitleOptions } from "./auto-title.js"
import type { EnhanceResponse } from "./enhance-prompt.js"

function okResponse(body: unknown): EnhanceResponse {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function httpError(status: number, detail = "nope"): EnhanceResponse {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => detail,
  }
}

interface Captured {
  url: string
  init: Record<string, unknown>
}

function fakeFetch(reply: EnhanceResponse): {
  fetchImpl: (url: string, init: Record<string, unknown>) => Promise<EnhanceResponse>
  captured: Captured[]
} {
  const captured: Captured[] = []
  return {
    captured,
    fetchImpl: async (url, init) => {
      captured.push({ url, init })
      return reply
    },
  }
}

const base: AutoTitleOptions = { baseUrl: "https://integrate.api.nvidia.com", apiKey: "k", model: "m" }

const replyBody = (text: unknown): unknown => ({
  choices: [{ message: { content: text } }],
})

describe("TITLE_INSTRUCTION", () => {
  it("demands a bare five-word-max title on a single line", () => {
    expect(TITLE_INSTRUCTION).toContain("AT MOST FIVE WORDS")
    expect(TITLE_INSTRUCTION).toContain("Return ONLY the title")
    expect(TITLE_INSTRUCTION.includes("\n")).toBe(false)
  })
})

describe("toFiveWords (hard cap + cleanup)", () => {
  it("caps to five words even when the model rambles", () => {
    expect(toFiveWords("one two three four five six seven")).toBe("one two three four five")
  })

  it("strips fences, wrapping quotes, and trailing punctuation", () => {
    expect(toFiveWords("```\nFix the login bug\n```")).toBe("Fix the login bug")
    expect(toFiveWords('"Fix the login token refresh bug, please!"')).toBe("Fix the login token refresh")
    expect(toFiveWords('"Done"')).toBe("Done")
  })

  it("collapses whitespace and returns '' for empty/debris input", () => {
    expect(toFiveWords("  Fix   the\nlogin token  ")).toBe("Fix the login token")
    expect(toFiveWords("")).toBe("")
    expect(toFiveWords('"')).toBe("")
  })
})

describe("generateChatTitle", () => {
  it("POSTs the naming instruction and returns the cleaned title", async () => {
    const { fetchImpl, captured } = fakeFetch(okResponse(replyBody("Fix login token refresh")))
    const title = await generateChatTitle("User: hi\nAssistant: working on auth", { ...base, fetchImpl })
    expect(title).toBe("Fix login token refresh")
    expect(captured).toHaveLength(1)
    expect(captured[0]!.url).toBe("https://integrate.api.nvidia.com/v1/chat/completions")
    const init = captured[0]!.init
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k")
    expect(init.signal).toBeInstanceOf(AbortSignal)
    const payload = JSON.parse(init.body as string) as {
      model: string
      temperature: number
      messages: Array<{ role: string; content: string }>
    }
    expect(payload.model).toBe("m")
    expect(payload.temperature).toBeLessThan(1)
    expect(payload.messages[0]).toEqual({ role: "system", content: TITLE_INSTRUCTION })
    expect(payload.messages[1]!.content).toContain("User: hi")
  })

  it("enforces the five-word cap on a disobedient reply", async () => {
    const { fetchImpl } = fakeFetch(okResponse(replyBody("alpha beta gamma delta epsilon zeta eta")))
    expect(await generateChatTitle("x", { ...base, fetchImpl })).toBe("alpha beta gamma delta epsilon")
  })

  it("accepts the text-parts array shape", async () => {
    const { fetchImpl } = fakeFetch(okResponse(replyBody([{ type: "text", text: "Refactor auth flow" }])))
    expect(await generateChatTitle("x", { ...base, fetchImpl })).toBe("Refactor auth flow")
  })

  it("throws on HTTP errors, odd shapes, and an empty excerpt (caller falls back)", async () => {
    const err = fakeFetch(httpError(500, "boom"))
    await expect(generateChatTitle("x", { ...base, fetchImpl: err.fetchImpl })).rejects.toThrow(
      "title failed: HTTP 500",
    )
    const odd = fakeFetch(okResponse({ nope: true }))
    await expect(generateChatTitle("x", { ...base, fetchImpl: odd.fetchImpl })).rejects.toThrow(
      "unexpected response shape",
    )
    const none = fakeFetch(okResponse(replyBody("Fix it")))
    await expect(generateChatTitle("   ", { ...base, fetchImpl: none.fetchImpl })).rejects.toThrow("nothing to title")
    expect(none.captured).toHaveLength(0) // empty excerpt never reaches the wire
  })
})
