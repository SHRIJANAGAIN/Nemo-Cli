/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { createOpenAIProvider } from "./openai.js"
import { createXAIProvider } from "./xai.js"
import { createHuggingFaceProvider } from "./huggingface.js"
import { createCustomProvider } from "./custom.js"
import { createNvidiaProvider, nvidiaReasoningParamsAllowed } from "./nvidia.js"
import { createLlamaCppProvider } from "./llama-cpp.js"
import { createAnthropicProvider, toAnthropicBody } from "./anthropic.js"
import { createGoogleProvider, toGeminiBody } from "./google.js"
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
 * Built-in OpenAI-compatible providers (openai/xai/huggingface/custom):
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

describe("openai/xai/huggingface/custom providers", () => {
  it("exposes the right ids", () => {
    const opts = { baseUrl: "http://x", model: "m" }
    expect(createOpenAIProvider(opts).id).toBe("openai")
    expect(createXAIProvider(opts).id).toBe("xai")
    expect(createHuggingFaceProvider(opts).id).toBe("huggingface")
    expect(createCustomProvider(opts).id).toBe("custom")
    expect(createNvidiaProvider(opts).id).toBe("nvidia")
  })

  it("openai posts model + tools to /v1/chat/completions with Bearer auth", async () => {
    let seen!: Captured
    await withStub(async (stubUrl) => {
      const p = createOpenAIProvider({ baseUrl: stubUrl, model: "gpt-4o", apiKey: "k" })
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
    expect(seen.body.model).toBe("gpt-4o")
    expect(Array.isArray(seen.body.tools)).toBe(true)
  }, 15000)

  it("openai maps reasoningEffort to reasoning_effort", async () => {
    const seen = await withStub(async (stubUrl) => {
      const p = createOpenAIProvider({ baseUrl: stubUrl, model: "gpt-4o", reasoningEffort: "high" })
      await p.chat(toolInput)
    })
    expect(seen.body.reasoning_effort).toBe("high")
    expect(seen.body).not.toHaveProperty("reasoning_tokens")
  }, 15000)

  it("xai/huggingface/custom send no reasoning params", async () => {
    for (const make of [createXAIProvider, createHuggingFaceProvider, createCustomProvider]) {
      const seen = await withStub(async (stubUrl) => {
        const p = make({ baseUrl: stubUrl, model: "m", reasoningEffort: "high" })
        await p.chat(toolInput)
      })
      expect(seen.body).not.toHaveProperty("reasoning_tokens")
      expect(seen.body).not.toHaveProperty("reasoning_effort")
    }
  }, 15000)

  it("registry knows all 22 types (case-insensitive)", () => {
    const registry = createProviderRegistry()
    for (const t of [
      "llamacpp",
      "nvidia",
      "nvidia-nim",
      "openai",
      "xai",
      "huggingface",
      "anthropic",
      "google",
      "ollama",
      "custom",
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
      "skt-gateway",
      "OpenAI",
    ]) {
      expect(registry.has(t)).toBe(true)
    }
    expect(registry.create("xai", { baseUrl: "http://x", model: "m" })?.id).toBe("xai")
    expect(registry.create("openai", { baseUrl: "http://x", model: "m" })?.id).toBe("openai")
    expect(registry.create("anthropic", { baseUrl: "http://x", model: "m" })?.id).toBe("anthropic")
    expect(registry.create("google", { baseUrl: "http://x", model: "m" })?.id).toBe("google")
    expect(registry.create("nvidia-nim", { baseUrl: "http://x", model: "m" })?.id).toBe("nvidia")
    expect(registry.create("ollama", { baseUrl: "http://x", model: "m" })?.id).toBe("ollama")
    expect(registry.create("nope", { baseUrl: "http://x", model: "m" })).toBeUndefined()
  })
})

describe("anthropic/google providers", () => {
  it("exposes the right ids + defaults", () => {
    expect(createAnthropicProvider({ baseUrl: "", model: "" }).id).toBe("anthropic")
    expect(createGoogleProvider({ baseUrl: "", model: "" }).id).toBe("google")
  })

  it("anthropic maps system/tools/tool-results to Messages shape", () => {
    const body = toAnthropicBody(
      {
        system: "sys",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "toolu_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
            ],
          },
          { role: "tool", content: "ok", tool_call_id: "toolu_1" },
        ],
        tools: [
          {
            timeoutMs: 30_000,
            name: "bash",
            description: "run",
            parameters: { type: "object", properties: {}, required: [] },
          },
        ],
      },
      "claude-3-5-sonnet-latest",
    )
    expect(body.model).toBe("claude-3-5-sonnet-latest")
    // #123: the system prompt is a cacheable BLOCK, not a bare string —
    // Anthropic only honours a prompt-cache breakpoint on block form. The
    // text itself is unchanged.
    expect(body.system).toEqual([{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }])
    expect(Array.isArray(body.tools)).toBe(true)
    const msgs = body.messages as Array<{ role: string; content: unknown }>
    expect(msgs[0].role).toBe("user")
    expect(msgs[1].role).toBe("assistant")
    expect(msgs[2].role).toBe("user")
  })

  it("anthropic streams text + tool_use off a stub", async () => {
    const server = http.createServer((req, res) => {
      let raw = ""
      req.on("data", (c) => (raw += c))
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.end(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1}}}\n\n' +
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n' +
            'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"bash","input":{}}}\n\n' +
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}\n\n' +
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        )
      })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as AddressInfo).port
    try {
      const p = createAnthropicProvider({
        baseUrl: `http://127.0.0.1:${port}`,
        model: "claude-3-5-sonnet-latest",
        apiKey: "k",
      })
      const msg = await p.chat({ messages: [{ role: "user", content: "hi" }] })
      expect(msg.content.find((c) => c.type === "text" && "text" in c && c.text === "Hello")).toBeTruthy()
      const tc = msg.content.find((c) => c.type === "toolCall")
      expect(tc && "name" in tc ? tc.name : "").toBe("bash")
      expect(msg.stopReason).toBe("tool_use")
    } finally {
      server.close()
    }
  }, 15000)

  it("google maps messages to contents + parses generateContent", async () => {
    const body = toGeminiBody(
      {
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
      },
      "gemini-2.5-flash",
    ) as { contents: unknown[]; system_instruction: unknown; tools: unknown[] }
    expect(Array.isArray(body.contents)).toBe(true)
    expect(body.system_instruction).toBeTruthy()
    expect(Array.isArray(body.tools)).toBe(true)

    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: "Hello" }, { functionCall: { name: "bash", args: { command: "ls" } } }] },
              finishReason: "STOP",
            },
          ],
        }),
      )
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as AddressInfo).port
    try {
      const p = createGoogleProvider({ baseUrl: `http://127.0.0.1:${port}`, model: "gemini-2.5-flash", apiKey: "k" })
      const msg = await p.chat({ messages: [{ role: "user", content: "hi" }] })
      expect(msg.stopReason).toBe("tool_use")
      expect(msg.content.some((c) => c.type === "toolCall" && "name" in c && c.name === "bash")).toBe(true)
    } finally {
      server.close()
    }
  }, 15000)

  it("google authenticates via the x-goog-api-key header, never the URL (#70)", async () => {
    let seenUrl = ""
    let seenKey: string | string[] | undefined
    const server = http.createServer((req, res) => {
      seenUrl = req.url ?? ""
      seenKey = req.headers["x-goog-api-key"]
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }))
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as AddressInfo).port
    try {
      const p = createGoogleProvider({
        baseUrl: `http://127.0.0.1:${port}`,
        model: "gemini-2.5-flash",
        apiKey: "sekrit",
      })
      await p.chat({ messages: [{ role: "user", content: "hi" }] })
      expect(seenKey).toBe("sekrit")
      expect(seenUrl).not.toContain("key=")
      expect(seenUrl).toContain(":generateContent")
    } finally {
      server.close()
    }
  }, 15000)

  it("fetchModelsDetailed sends the Google key as a header, not a query param (#70)", async () => {
    let seenUrl = ""
    let seenKey: string | string[] | undefined
    const server = http.createServer((req, res) => {
      seenUrl = req.url ?? ""
      seenKey = req.headers["x-goog-api-key"]
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ models: [{ name: "models/gemini-2.5-flash" }, { name: "models/gemini-2.0-flash" }] }))
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as AddressInfo).port
    try {
      const status = await fetchModelsDetailed("google", `http://127.0.0.1:${port}/v1beta`, "sekrit")
      expect(status.source).toBe("live")
      expect(status.models).toContain("gemini-2.5-flash")
      expect(seenKey).toBe("sekrit")
      expect(seenUrl).not.toContain("key=")
    } finally {
      server.close()
    }
  }, 15000)

  it("verifyProviderKey sends the Google key as a header, not a query param (#70)", async () => {
    let seenUrl = ""
    let seenKey: string | string[] | undefined
    const server = http.createServer((req, res) => {
      seenUrl = req.url ?? ""
      seenKey = req.headers["x-goog-api-key"]
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }))
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as AddressInfo).port
    try {
      const result = await verifyProviderKey("google", `http://127.0.0.1:${port}/v1beta`, "sekrit", "gemini-2.5-flash")
      expect(result.ok).toBe(true)
      expect(seenKey).toBe("sekrit")
      expect(seenUrl).not.toContain("key=")
    } finally {
      server.close()
    }
  }, 15000)

  it("catalog covers all 21 backends with fetch fallback", async () => {
    expect(PROVIDER_CATALOG.length).toBe(21)
    for (const id of [
      "huggingface",
      "nvidia-nim",
      "nvidia",
      "openai",
      "anthropic",
      "google",
      "xai",
      "ollama",
      "custom",
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
      "skt-gateway",
    ]) {
      expect(getCatalogEntry(id)?.defaultBaseUrl.length).toBeGreaterThan(0)
    }
    // Unreachable endpoint → static fallback, never rejects.
    const ids = await fetchModelsForProvider("anthropic", "http://127.0.0.1:1", "bad")
    expect(ids.length).toBeGreaterThan(0)
  }, 15000)

  it("detailed fetch reports fallback + network error kind", async () => {
    const res = await fetchModelsDetailed("openai", "http://127.0.0.1:1", "bad")
    expect(res.source).toBe("fallback")
    expect(res.error).toBe("network")
    expect(res.models.length).toBeGreaterThan(0)
  }, 15000)

  it("ollama lists via /api/tags and chats OpenAI-compatible without a key", async () => {
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
      const ok = await verifyProviderKey("huggingface", `http://127.0.0.1:${port}`, "k", "m")
      expect(ok.ok).toBe(true)
      expect(ok.status).toBe(200)
      mode = "denied"
      const bad = await verifyProviderKey("huggingface", `http://127.0.0.1:${port}`, "k", "m")
      expect(bad.ok).toBe(false)
      expect(bad.status).toBe(401)
      expect(bad.hint ?? "").toContain("Inference Providers")
    } finally {
      server.close()
    }
  }, 15000)

  it("gateway providers keep truthful ids and chat OpenAI-compatible", async () => {
    const { createOpenAICompatibleProvider } = await import("./openai.js")
    const registry = createProviderRegistry()
    for (const id of ["groq", "openrouter", "skt-gateway", "azure"]) {
      expect(registry.has(id)).toBe(true)
      const p = registry.create(id, { baseUrl: "http://x", model: "m" })
      expect(p?.id).toBe(id)
    }
    const seen = await withStub(async (stubUrl) => {
      const make = createOpenAICompatibleProvider("openrouter", "OpenRouter API", stubUrl, "m")
      const p = make({ baseUrl: stubUrl, model: "m", reasoningEffort: "high" })
      expect(p.id).toBe("openrouter")
      await p.chat(toolInput)
    })
    // No gateway-specific reasoning params leak to proxied models.
    expect(seen.body).not.toHaveProperty("reasoning_tokens")
    expect(seen.body).not.toHaveProperty("reasoning_effort")
    expect(seen.url).toBe("/v1/chat/completions")
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
    // gateways 400 — the same rule OpenAICompatibleProvider already
    // applies wholesale (test above), now pinned for nvidia itself.
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

  it("nvidia/openai clamp chat temperature to 0–2 (the reported 400)", async () => {
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
    // OpenAI + xAI ride NvidiaProvider.buildBody — same ceiling by inheritance.
    const seenOpenAI = await withStub(async (stubUrl) => {
      const p = createOpenAIProvider({ baseUrl: stubUrl, model: "m", temperature: 2.7 })
      await p.chat({ messages: [{ role: "user", content: "hi" }] })
    })
    expect(seenOpenAI.body.temperature).toBe(2)
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

  it("anthropic clamps to 0–1 and still omits an unset temperature", async () => {
    const bodies: Record<string, unknown>[] = []
    const server = http.createServer((req, res) => {
      let raw = ""
      req.on("data", (c) => (raw += c))
      req.on("end", () => {
        bodies.push(JSON.parse(raw) as Record<string, unknown>)
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.end(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1}}}\n\n' +
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        )
      })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as AddressInfo).port
    try {
      const hot = createAnthropicProvider({
        baseUrl: `http://127.0.0.1:${port}`,
        model: "claude-3-5-sonnet-latest",
        apiKey: "k",
        temperature: 2.7,
      })
      await hot.chat({ messages: [{ role: "user", content: "hi" }] })
      const unset = createAnthropicProvider({ baseUrl: `http://127.0.0.1:${port}`, model: "m", apiKey: "k" })
      await unset.chat({ messages: [{ role: "user", content: "hi" }] })
    } finally {
      server.close()
    }
    expect(bodies).toHaveLength(2)
    expect(bodies[0]?.temperature).toBe(1)
    expect(bodies[1]).not.toHaveProperty("temperature")
  }, 15000)

  it("google clamps generationConfig.temperature to 0–2", async () => {
    const bodies: Record<string, unknown>[] = []
    const server = http.createServer((req, res) => {
      let raw = ""
      req.on("data", (c) => (raw += c))
      req.on("end", () => {
        bodies.push(JSON.parse(raw) as Record<string, unknown>)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }],
          }),
        )
      })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as AddressInfo).port
    try {
      const p = createGoogleProvider({
        baseUrl: `http://127.0.0.1:${port}`,
        model: "gemini-2.5-flash",
        apiKey: "k",
        temperature: 2.7,
      })
      await p.chat({ messages: [{ role: "user", content: "hi" }] })
    } finally {
      server.close()
    }
    expect(bodies).toHaveLength(1)
    const gen = bodies[0]?.generationConfig as Record<string, unknown> | undefined
    expect(gen?.temperature).toBe(2)
  }, 15000)

  it("google maps INCOMPLETE (Gemini length condition) to length, not end_turn", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "INCOMPLETE" }] }),
      )
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as AddressInfo).port
    try {
      const p = createGoogleProvider({
        baseUrl: `http://127.0.0.1:${port}`,
        model: "gemini-2.5-flash",
        apiKey: "k",
      })
      const msg = await p.chat({ messages: [{ role: "user", content: "hi" }] })
      expect(msg.stopReason).toBe("length")
    } finally {
      server.close()
    }
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
