/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { createCustomProvider } from "./custom.js"
import { createNvidiaProvider, nvidiaReasoningParamsAllowed } from "./nvidia.js"
import { createLlamaCppProvider } from "./llama-cpp.js"
import { createOllamaProvider } from "./ollama.js"
import { normalizeCustomBaseUrl } from "./custom.js"
import {
  PROVIDER_CATALOG,
  getCatalogEntry,
  fetchModelsForProvider,
  fetchModelsDetailed,
  verifyProviderKey,
} from "./catalog.js"
import { createProviderRegistry } from "../../core/src/providers/registry.js"
import type { ChatInput } from "./types.js"
import { clampTemperature } from "./types.js"

/**
 * The surviving backends (nvidia, nvidia-nim, ollama, llama.cpp, custom):
 * request shaping + SSE assembly, against a local stub — no network.
 */

interface Captured {
  url: string
  auth?: string
  body: Record<string, unknown>
}

const SSE_TEXT = 'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n'
const SSE_TOOL_1 =
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":"{\\"command\\":"}}]},"index":0}]}\n\n'
const SSE_TOOL_2 =
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"index":0}]}\n\n'
const SSE_STOP = 'data: {"choices":[{"finish_reason":"tool_calls","index":0}]}\n\n' + "data: [DONE]\n\n"

async function withStub(run: (stubUrl: string) => Promise<void>): Promise<Captured> {
  let captured: Captured | null = null
  const server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => {
      raw += c
    })
    req.on("end", () => {
      captured = {
        url: req.url ?? "",
        auth: req.headers.authorization as string | undefined,
        body: JSON.parse(raw) as Record<string, unknown>,
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.end(SSE_TEXT + SSE_TOOL_1 + SSE_TOOL_2 + SSE_STOP)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    server.close()
  }
  if (!captured) throw new Error("stub saw no request")
  return captured
}

const toolInput: ChatInput = {
  system: "sys",
  messages: [{ role: "user", content: "hi" }],
  tools: [
    {
      timeoutMs: 30_000,
      name: "bash",
      description: "run",
      parameters: { type: "object", properties: {}, required: [] },
    },
  ],
}

describe("nvidia/ollama/custom/llama.cpp providers", () => {
  it("exposes the right ids", () => {
    const opts = { baseUrl: "http://x", model: "m" }
    expect(createCustomProvider(opts).id).toBe("custom")
    expect(createOllamaProvider(opts).id).toBe("ollama")
    expect(createNvidiaProvider(opts).id).toBe("nvidia")
    expect(createLlamaCppProvider(opts).id).toBe("llama.cpp")
  })

  it("nvidia posts model + tools to /v1/chat/completions with Bearer auth", async () => {
    let seen!: Captured
    await withStub(async (stubUrl) => {
      const p = createNvidiaProvider({ baseUrl: stubUrl, model: "nvidia/nemotron-3-super-120b-a12b", apiKey: "k" })
      const msg = await p.chat(toolInput)
      const text = msg.content.find((c) => c.type === "text")
      expect(text && "text" in text ? text.text : "").toBe("Hello")
      const tc = msg.content.find((c) => c.type === "toolCall")
      expect(tc && "name" in tc ? tc.name : "").toBe("bash")
      expect(tc && "arguments" in tc ? (tc.arguments as Record<string, unknown>).command : "").toBe("ls")
      expect(msg.stopReason).toBe("tool_use")
    }).then((c) => {
      seen = c
    })
    expect(seen.url).toBe("/v1/chat/completions")
    expect(seen.auth).toBe("Bearer k")
    expect(seen.body.model).toBe("nvidia/nemotron-3-super-120b-a12b")
    expect(Array.isArray(seen.body.tools)).toBe(true)
  }, 15000)

  it("rejects a junk or missing key for NVIDIA's cloud before spending a request", async () => {
    const junk = createNvidiaProvider({ baseUrl: "https://integrate.api.nvidia.com", model: "m", apiKey: "hi" })
    await expect(junk.chat(toolInput)).rejects.toThrow(/does not start with "nvapi-"/)
    const empty = createNvidiaProvider({ baseUrl: "https://integrate.api.nvidia.com", model: "m" })
    await expect(empty.chat(toolInput)).rejects.toThrow(/No NVIDIA API key configured/)
  })

  it("ollama/custom send no reasoning params", async () => {
    for (const make of [createOllamaProvider, createCustomProvider]) {
      const seen = await withStub(async (stubUrl) => {
        const p = make({ baseUrl: stubUrl, model: "m", reasoningEffort: "high" })
        await p.chat(toolInput)
      })
      expect(seen.body).not.toHaveProperty("reasoning_tokens")
      expect(seen.body).not.toHaveProperty("reasoning_effort")
    }
  }, 15000)

  it("registry knows every surviving type (case-insensitive)", () => {
    const registry = createProviderRegistry()
    for (const t of ["llamacpp", "nvidia", "nvidia-nim", "ollama", "custom", "NVIDIA"]) {
      expect(registry.has(t)).toBe(true)
    }
    expect(registry.create("nvidia-nim", { baseUrl: "http://x", model: "m" })?.id).toBe("nvidia")
    expect(registry.create("ollama", { baseUrl: "http://x", model: "m" })?.id).toBe("ollama")
    expect(registry.create("custom", { baseUrl: "http://x", model: "m" })?.id).toBe("custom")
    expect(registry.create("llamacpp", { baseUrl: "http://x", model: "m" })?.id).toBe("llama.cpp")
    expect(registry.create("nope", { baseUrl: "http://x", model: "m" })).toBeUndefined()
  })

  it("the removed cloud backends are gone from the registry", () => {
    const registry = createProviderRegistry()
    for (const t of [
      "openai",
      "xai",
      "huggingface",
      "anthropic",
      "google",
      "groq",
      "mistral",
      "cerebras",
      "together",
      "deepinfra",
      "cohere",
      "perplexity",
      "openrouter",
      "fireworks",
      "venice",
      "azure",
      "nemo-gateway",
    ]) {
      expect(registry.has(t), t).toBe(false)
    }
  })
})

describe("catalog", () => {
  it("covers the surviving backends with fetch fallback", async () => {
    expect(PROVIDER_CATALOG.length).toBe(5)
    for (const id of ["nvidia-nim", "nvidia", "llamacpp", "ollama", "custom"]) {
      expect(getCatalogEntry(id)?.defaultBaseUrl.length).toBeGreaterThan(0)
    }
    // Unreachable endpoint → static fallback, never rejects.
    const ids = await fetchModelsForProvider("nvidia", "http://127.0.0.1:1", "bad")
    expect(ids.length).toBeGreaterThan(0)
  }, 15000)

  it("detailed fetch reports fallback + network error kind", async () => {
    const res = await fetchModelsDetailed("nvidia", "http://127.0.0.1:1", "bad")
    expect(res.source).toBe("fallback")
    expect(res.error).toBe("network")
    expect(res.models.length).toBeGreaterThan(0)
  }, 15000)

  it("ollama lists via /api/tags", async () => {
    expect(createOllamaProvider({ baseUrl: "", model: "" }).id).toBe("ollama")
    const server = http.createServer((req, res) => {
      if (req.url === "/api/tags") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ models: [{ name: "llama3.1:latest" }, { name: "qwen2.5-coder" }] }))
        return
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end('{"models":[]}')
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as AddressInfo).port
    try {
      const ids = await fetchModelsForProvider("ollama", `http://127.0.0.1:${port}`, "")
      expect(ids).toEqual(["llama3.1:latest", "qwen2.5-coder"])
    } finally {
      server.close()
    }
  }, 15000)

  it("custom folds pasted chat URLs back to the API base", () => {
    expect(normalizeCustomBaseUrl("http://x:8080/v1/chat/completions")).toBe("http://x:8080/v1")
    expect(normalizeCustomBaseUrl("http://x:8080/chat/completions/")).toBe("http://x:8080")
    expect(normalizeCustomBaseUrl("http://x:8080/v1/")).toBe("http://x:8080/v1")
    expect(normalizeCustomBaseUrl("")).toBe("http://localhost:8080")
  })

  it("verifyProviderKey pings the chat endpoint and reports 401 with hint", async () => {
    let mode = "ok"
    const server = http.createServer((req, res) => {
      if (mode === "denied") {
        res.writeHead(401, { "Content-Type": "application/json" })
        res.end('{"error":"Invalid username or password."}')
        return
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end('{"choices":[{"message":{"content":"hi"},"finish_reason":"stop"}]}')
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as AddressInfo).port
    try {
      const ok = await verifyProviderKey("nvidia", `http://127.0.0.1:${port}`, "k", "m")
      expect(ok.ok).toBe(true)
      expect(ok.status).toBe(200)
      mode = "denied"
      const bad = await verifyProviderKey("nvidia", `http://127.0.0.1:${port}`, "k", "m")
      expect(bad.ok).toBe(false)
      expect(bad.status).toBe(401)
      expect(bad.hint ?? "").toContain("nvapi")
    } finally {
      server.close()
    }
  }, 15000)
})

describe("nvidia reasoning params stay on NVIDIA's own endpoints", () => {
  it("nvidiaReasoningParamsAllowed only admits NVIDIA hosts (and unset)", () => {
    expect(nvidiaReasoningParamsAllowed("https://integrate.api.nvidia.com")).toBe(true)
    expect(nvidiaReasoningParamsAllowed("https://integrate.api.nvidia.com/v1")).toBe(true)
    expect(nvidiaReasoningParamsAllowed("https://build.nvidia.com")).toBe(true)
    // Unset: the class targets NVIDIA's own cloud by default.
    expect(nvidiaReasoningParamsAllowed("")).toBe(true)

    expect(nvidiaReasoningParamsAllowed("http://localhost:11434")).toBe(false)
    expect(nvidiaReasoningParamsAllowed("https://omniroute.example/v1")).toBe(false)
    // Scheme-less / opaque targets are not provably NVIDIA — refuse.
    expect(nvidiaReasoningParamsAllowed("definitely-not-a-url")).toBe(false)
  })

  it("a custom-gateway baseUrl gets no NVIDIA-dialect reasoning field", async () => {
    // reasoning_tokens on a non-NVIDIA endpoint is exactly how strict
    // gateways 400 — the same rule the local runtimes already apply
    // wholesale, now pinned for nvidia itself.
    const seen = await withStub(async (stubUrl) => {
      const p = createNvidiaProvider({ baseUrl: stubUrl, model: "m", reasoningEffort: "high" })
      await p.chat(toolInput)
    })
    expect(seen.body).not.toHaveProperty("reasoning_tokens")
    expect(seen.body).not.toHaveProperty("reasoning_effort")
  }, 15000)
})

describe("temperature clamping (per-backend ceilings)", () => {
  it("clampTemperature bounds finite input and falls back otherwise", () => {
    expect(clampTemperature(2.7, 0.7, 2)).toBe(2)
    expect(clampTemperature(-1, 0.7, 2)).toBe(0)
    expect(clampTemperature(0.5, 0.7, 2)).toBe(0.5)
    expect(clampTemperature(2, 0.7, 2)).toBe(2)
    expect(clampTemperature(undefined, 0.7, 2)).toBe(0.7)
    expect(clampTemperature(Number.NaN, 0.7, 2)).toBe(0.7)
    expect(clampTemperature(Number.POSITIVE_INFINITY, 1, 1)).toBe(1)
  })

  it("nvidia clamps chat temperature to 0–2 (the reported 400)", async () => {
    for (const [temp, want] of [
      [2.7, 2],
      [-1, 0],
    ] as Array<[number, number]>) {
      const seen = await withStub(async (stubUrl) => {
        const p = createNvidiaProvider({ baseUrl: stubUrl, model: "m", temperature: temp })
        await p.chat({ messages: [{ role: "user", content: "hi" }] })
      })
      expect(seen.body.temperature).toBe(want)
    }
  }, 15000)

  it("llama-cpp clamps chat temperature to 0–2 (local servers accept anything)", async () => {
    // A local backend never 400s — 2.7 sails through and the sampler melts
    // into multilingual mush (observed live). Same ceiling as hosted.
    for (const [temp, want] of [
      [2.7, 2],
      [-1, 0],
    ] as Array<[number, number]>) {
      const seen = await withStub(async (stubUrl) => {
        const p = createLlamaCppProvider({ baseUrl: stubUrl, model: "m", temperature: temp })
        await p.chat({ messages: [{ role: "user", content: "hi" }] })
      })
      expect(seen.body.temperature).toBe(want)
    }
    const def = await withStub(async (stubUrl) => {
      const p = createLlamaCppProvider({ baseUrl: stubUrl, model: "m" })
      await p.chat({ messages: [{ role: "user", content: "hi" }] })
    })
    expect(def.body.temperature).toBe(0.7)
  }, 15000)

  it("llama-cpp maps max_tokens/incomplete finish reasons to length, not end_turn", async () => {
    for (const reason of ["max_tokens", "incomplete"]) {
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.end(
          `data: {"choices":[{"delta":{"content":"partial answer"},"index":0}]}\n\n` +
            `data: {"choices":[{"finish_reason":"${reason}","index":0}]}\n\n` +
            "data: [DONE]\n\n",
        )
      })
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
      const port = (server.address() as AddressInfo).port
      try {
        const p = createLlamaCppProvider({ baseUrl: `http://127.0.0.1:${port}`, model: "m" })
        const msg = await p.chat({ messages: [{ role: "user", content: "hi" }] })
        expect(msg.stopReason).toBe("length")
      } finally {
        server.close()
      }
    }
  }, 15000)

  it("does not duplicate reasoning-only streams into a text part (nvidia + llama-cpp)", async () => {
    const sse =
      'data: {"choices":[{"delta":{"reasoning_content":"thinking hard"},"index":0}]}\n\n' +
      'data: {"choices":[{"delta":{"reasoning_content":"still at it"},"index":0}]}\n\n' +
      'data: {"choices":[{"finish_reason":"length","index":0}]}\n\n' +
      "data: [DONE]\n\n"
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.end(sse)
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as AddressInfo).port
    try {
      for (const make of [createNvidiaProvider, createLlamaCppProvider]) {
        const p = make({ baseUrl: `http://127.0.0.1:${port}`, model: "m" } as Parameters<typeof make>[0])
        const msg = await p.chat({ messages: [{ role: "user", content: "hi" }] })
        const textParts = msg.content.filter((c) => c.type === "text")
        expect(textParts).toHaveLength(0)
        const thinking = msg.content.filter((c) => c.type === "thinking")
        expect(thinking.length).toBeGreaterThan(0)
      }
    } finally {
      server.close()
    }
  }, 15000)
})
