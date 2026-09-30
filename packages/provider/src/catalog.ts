/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as http from "http"
import * as https from "https"
import * as url from "url"

export type ProviderId =
  | "llamacpp"
  | "nvidia"
  | "nvidia-nim"
  | "openai"
  | "xai"
  | "huggingface"
  | "anthropic"
  | "google"
  | "ollama"
  | "custom"
  | "groq"
  | "mistral"
  | "cerebras"
  | "together"
  | "deepinfra"
  | "cohere"
  | "perplexity"
  | "openrouter"
  | "fireworks"
  | "venice"
  | "azure"
  | "skt-gateway"

export interface ProviderCatalogEntry {
  id: ProviderId
  label: string
  defaultBaseUrl: string
  defaultModel: string
  needsBaseUrl: boolean
  needsApiKey: boolean
  /** Key asked but skippable (local endpoints that may take none). */
  keyOptional?: boolean
  staticModels: string[]
}

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: "huggingface",
    label: "Hugging Face",
    defaultBaseUrl: "https://router.huggingface.co/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct",
    needsBaseUrl: false,
    needsApiKey: true,
    // Refreshed from the live router list (Sep 2026): servable chat/coding
    // ids. Live /v1/models is the source of truth; these are fallback only.
    staticModels: [
      "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      "deepseek-ai/DeepSeek-V3.1",
      "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
      "moonshotai/Kimi-K2-Instruct",
      "meta-llama/Llama-3.3-70B-Instruct",
      "Qwen/Qwen2.5-Coder-7B-Instruct",
      "google/gemma-3-12b-it",
    ],
  },
  {
    id: "nvidia-nim",
    label: "NVIDIA NIM",
    defaultBaseUrl: "https://integrate.api.nvidia.com",
    defaultModel: "nvidia/nemotron-3-super-120b-a12b",
    needsBaseUrl: false,
    needsApiKey: true,
    staticModels: [
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia/llama-3.3-70b-instruct",
      "nvidia/qwen-2.5-72b-instruct",
      "nvidia/mixtral-8x7b-instruct",
    ],
  },
  {
    id: "nvidia",
    label: "NVIDIA",
    defaultBaseUrl: "https://integrate.api.nvidia.com",
    defaultModel: "nvidia/nemotron-3-super-120b-a12b",
    needsBaseUrl: false,
    needsApiKey: true,
    staticModels: [
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia/llama-3.3-70b-instruct",
      "nvidia/qwen-2.5-72b-instruct",
      "nvidia/mixtral-8x7b-instruct",
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com",
    defaultModel: "gpt-4o",
    needsBaseUrl: false,
    needsApiKey: true,
    staticModels: ["gpt-4o", "gpt-4o-mini", "gpt-5", "gpt-5-mini", "gpt-4.1", "o3-mini"],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModel: "claude-3-5-sonnet-latest",
    needsBaseUrl: false,
    needsApiKey: true,
    staticModels: [
      "claude-3-5-sonnet-latest",
      "claude-3-5-haiku-latest",
      "claude-3-opus-latest",
      "claude-sonnet-4-20250514",
    ],
  },
  {
    id: "google",
    label: "Google",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-flash",
    needsBaseUrl: false,
    needsApiKey: true,
    staticModels: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-pro-latest"],
  },
  {
    id: "xai",
    label: "xAI Grok",
    defaultBaseUrl: "https://api.x.ai",
    defaultModel: "grok-4",
    needsBaseUrl: false,
    needsApiKey: true,
    staticModels: ["grok-4", "grok-3", "grok-3-mini", "grok-2-1212"],
  },
  {
    id: "custom",
    label: "Custom endpoint",
    defaultBaseUrl: "http://localhost:8080",
    defaultModel: "",
    needsBaseUrl: true,
    needsApiKey: false,
    keyOptional: true,
    staticModels: [],
  },
  {
    // VS Code BYOK ollamaProvider port: local server, no key, native
    // /api/tags list, OpenAI-compatible chat.
    id: "ollama",
    label: "Ollama",
    defaultBaseUrl: "http://localhost:11434",
    defaultModel: "llama3.1",
    needsBaseUrl: true,
    needsApiKey: false,
    keyOptional: true,
    staticModels: ["llama3.1", "qwen2.5-coder", "mistral", "gemma2", "deepseek-r1", "codellama"],
  },
  {
    id: "groq",
    label: "Groq",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    needsBaseUrl: false,
    needsApiKey: true,
    staticModels: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "qwen-qwq-32b", "deepseek-r1-distill-llama-70b"],
  },
  {
    id: "mistral",
    label: "Mistral",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
    needsBaseUrl: false,
    needsApiKey: true,
    staticModels: ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest", "codestral-latest"],
  },
  {
    id: "cerebras",
    label: "Cerebras",
    defaultBaseUrl: "https://api.cerebras.ai/v1",
    defaultModel: "llama3.1-70b",
    needsBaseUrl: false,
    needsApiKey: true,
    staticModels: ["llama3.1-70b", "llama3.1-8b", "qwen-3-coder-480b"],
  },
  {
    id: "together",
    label: "Together AI",
    defaultBaseUrl: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    needsBaseUrl: false,
    needsApiKey: true,
    staticModels: [
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "deepseek-ai/DeepSeek-V3",
      "Qwen/Qwen2.5-Coder-32B-Instruct",
    ],
  },
  {
    id: "deepinfra",
    label: "DeepInfra",
    defaultBaseUrl: "https://api.deepinfra.com/v1/openai",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct",
    needsBaseUrl: false,
    needsApiKey: true,
    staticModels: ["meta-llama/Llama-3.3-70B-Instruct", "deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-Coder-32B-Instruct"],
  },
  {
    id: "cohere",
    label: "Cohere",
    defaultBaseUrl: "https://api.cohere.com/compatibility/v1",
    defaultModel: "command-r-plus",
    needsBaseUrl: false,
    needsApiKey: true,
    staticModels: ["command-r-plus", "command-r", "command-a-03-2025"],
  },
  {
    id: "perplexity",
    label: "Perplexity",
    defaultBaseUrl: "https://api.perplexity.ai",
    defaultModel: "sonar-pro",
    needsBaseUrl: false,
    needsApiKey: true,
    staticModels: ["sonar-pro", "sonar", "sonar-reasoning-pro"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4",
    needsBaseUrl: false,
    needsApiKey: true,
    // Live /v1/models returns 500+ ids; these are fallback only.
    staticModels: [
      "anthropic/claude-sonnet-4",
      "openai/gpt-4o",
      "google/gemini-2.5-pro",
      "meta-llama/llama-3.3-70b-instruct",
      "deepseek/deepseek-chat",
    ],
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    needsBaseUrl: false,
    needsApiKey: true,
    staticModels: [
      "accounts/fireworks/models/llama-v3p3-70b-instruct",
      "accounts/fireworks/models/qwen2p5-coder-32b-instruct",
      "accounts/fireworks/models/deepseek-v3",
    ],
  },
  {
    id: "venice",
    label: "Venice AI",
    defaultBaseUrl: "https://api.venice.ai/api/v1",
    defaultModel: "llama-3.3-70b",
    needsBaseUrl: false,
    needsApiKey: true,
    staticModels: ["llama-3.3-70b", "qwen-2.5-coder-32b", "dolphin-2.9.2-qwen2-72b"],
  },
  {
    id: "azure",
    label: "Azure OpenAI",
    defaultBaseUrl: "https://YOUR-RESOURCE.openai.azure.com/openai/deployments",
    defaultModel: "gpt-4o",
    needsBaseUrl: true,
    needsApiKey: true,
    staticModels: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3-mini"],
  },
  {
    id: "skt-gateway",
    label: "SKT Gateway",
    defaultBaseUrl: "https://gateway.skt-ai-labs.example/v1",
    defaultModel: "auto",
    needsBaseUrl: true,
    needsApiKey: true,
    // Unified gateway: live /v1/models is the source of truth (500+ ids
    // when backed by OpenRouter-compatible aggregation); statics below.
    staticModels: ["auto", "openai/gpt-4o", "anthropic/claude-sonnet-4", "google/gemini-2.5-pro"],
  },
]

export function getCatalogEntry(id: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((e) => e.id === id.toLowerCase())
}

function getJson(getUrl: string, headers: Record<string, string>, timeoutMs = 10_000): Promise<unknown> {
  return postThenParse(getUrl, "GET", headers, undefined, timeoutMs)
}

/** Raw HTTP helper returning status + parsed (or raw) body — for key
 *  verification where the status code itself is the signal. `keepBytes`
 *  caps the body kept: key checks only need a snippet for the hint, while
 *  JSON parsing must see the WHOLE payload — the old unconditional 500-byte
 *  slice turned every >500-byte /v1/models reply into a JSON parse error
 *  that masqueraded as "empty" and dropped the picker onto the 5-row
 *  static fallback. */
function postRaw(
  targetUrl: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs = 30_000,
  keepBytes = 500,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new url.URL(targetUrl)
    const isHttps = u.protocol === "https:"
    const lib = isHttps ? https : http
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method,
        timeout: timeoutMs,
        headers,
      },
      (res) => {
        let buf = ""
        res.setEncoding("utf8")
        res.on("data", (c) => (buf += c))
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: buf.length > keepBytes ? buf.slice(0, keepBytes) : buf }),
        )
      },
    )
    req.on("error", reject)
    req.on("timeout", () => {
      req.destroy()
      reject(new Error("Request timed out"))
    })
    req.end(body)
  })
}

// 8 MB cap for parsed bodies: far above any model list, still bounded.
const JSON_BODY_CAP = 8_000_000

function postThenParse(
  getUrl: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
): Promise<unknown> {
  return postRaw(getUrl, method, headers, body, timeoutMs, JSON_BODY_CAP).then(({ status, body: buf }) => {
    if (status >= 400) throw new Error(`HTTP ${status}: ${buf.slice(0, 200)}`)
    try {
      return JSON.parse(buf)
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err))
    }
  })
}

/**
 * Realtime model fetch per provider. Always resolves (never rejects) —
 * falls back to the catalog static list when the endpoint is unreachable
 * or the key is missing/invalid.
 */
export async function fetchModelsForProvider(providerId: string, baseUrl: string, apiKey: string): Promise<string[]> {
  return (await fetchModelsDetailed(providerId, baseUrl, apiKey)).models
}

export interface ModelFetchStatus {
  models: string[]
  /** "live" = endpoint answered; "fallback" = static list (see error). */
  source: "live" | "fallback"
  /** Machine hint: "auth" (401/403 — bad key), "network", or "empty". */
  error?: string
}

function errorKind(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/HTTP 401|HTTP 403/i.test(msg)) return "auth"
  if (/timed out|ENOTFOUND|ECONNREFUSED|Failed to fetch|network/i.test(msg)) return "network"
  return "empty"
}

/** Same as fetchModelsForProvider plus source/error for honest UI status. */
export async function fetchModelsDetailed(
  providerId: string,
  baseUrl: string,
  apiKey: string,
): Promise<ModelFetchStatus> {
  const id = providerId.toLowerCase()
  const entry = getCatalogEntry(id)
  const fallback = entry?.staticModels ?? []
  const fail = (error: string): ModelFetchStatus => ({ models: fallback, source: "fallback", error })
  try {
    if (id === "huggingface") {
      // 1) Router list (actually servable via the chat endpoint, key-gated).
      const base = (baseUrl || "https://router.huggingface.co/v1").replace(/\/+$/, "")
      try {
        const json = (await getJson(`${base}/v1/models`, {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        })) as { data?: Array<{ id?: string }> }
        const ids = (json.data ?? []).map((m) => m.id).filter((v): v is string => typeof v === "string" && v.length > 0)
        if (ids.length > 0) return { models: ids, source: "live" }
      } catch (routerErr) {
        // 401 (bad/foreign key) must surface, not silently fall back — but
        // still try the public Hub list so the user sees fresh models.
        const kind = errorKind(routerErr)
        const hub = await fetchHubTrending().catch(() => [] as string[])
        if (hub.length > 0) return { models: hub, source: "live", error: kind === "auth" ? "auth" : undefined }
        return fail(kind)
      }
      // Router answered but empty: Hub trending keeps the list fresh.
      const hub = await fetchHubTrending().catch(() => [] as string[])
      if (hub.length > 0) return { models: hub, source: "live" }
      return fail("empty")
    }
    if (id === "anthropic") {
      const base = (baseUrl || "https://api.anthropic.com").replace(/\/+$/, "")
      const json = (await getJson(`${base}/v1/models`, {
        ...(apiKey ? { "x-api-key": apiKey } : {}),
        "anthropic-version": "2023-06-01",
      })) as { data?: Array<{ id?: string }> }
      const ids = (json.data ?? []).map((m) => m.id).filter((v): v is string => typeof v === "string" && v.length > 0)
      return ids.length > 0 ? { models: ids, source: "live" } : fail("empty")
    }
    if (id === "google") {
      const base = (baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "")
      if (!apiKey) return fail("auth")
      const json = (await getJson(`${base}/models?key=${encodeURIComponent(apiKey)}`, {})) as {
        models?: Array<{ name?: string }>
      }
      const ids = (json.models ?? []).map((m) => (m.name ?? "").replace(/^models\//, "")).filter((v) => v.length > 0)
      return ids.length > 0 ? { models: ids, source: "live" } : fail("empty")
    }
    if (id === "ollama") {
      // Ollama-native list (VS Code ollamaProvider: GET {url}/api/tags).
      // No key; a stopped server falls through to statics via fail().
      const base = (baseUrl || "http://localhost:11434").replace(/\/+$/, "")
      const json = (await getJson(`${base}/api/tags`, {})) as {
        models?: Array<{ name?: string; model?: string }>
      }
      const ids = (json.models ?? []).map((m) => m.name ?? m.model ?? "").filter((v) => v.length > 0)
      return ids.length > 0 ? { models: ids, source: "live" } : fail("empty")
    }
    const base = (baseUrl || entry?.defaultBaseUrl || "").replace(/\/+$/, "")
    if (!base) return fail("empty")
    let parsed: url.URL
    try {
      parsed = new url.URL(base)
    } catch {
      return fail("empty")
    }
    void parsed
    // A saved baseUrl that already carries /v1 must not get /v1/v1/models
    // (404 → static list wearing a live outfit). Strip one trailing /v1.
    const listBase = base.replace(/\/v1\/?$/, "")
    const listOnce = (withAuth: boolean): Promise<unknown> =>
      getJson(`${listBase}/v1/models`, {
        ...(withAuth && apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      })
    // Model *listing* is public on several gateways (NVIDIA integrate.api
    // returns the full catalog keyless) — a rejected key must not hide the
    // models: retry keyless on 401/403. Chat still enforces the key itself
    // with the honest 401 hint.
    const json = (await listOnce(/*withAuth*/ true).catch((err): Promise<unknown> => {
      if (apiKey && errorKind(err) === "auth") return listOnce(/*withAuth*/ false)
      throw err
    })) as { data?: Array<{ id?: string }> }
    const ids = (json.data ?? []).map((m) => m.id).filter((v): v is string => typeof v === "string" && v.length > 0)
    return ids.length > 0 ? { models: ids, source: "live" } : fail("empty")
  } catch (err) {
    return fail(errorKind(err))
  }
}

/** Public Hub trending (no key): fresh text-generation ids when the gated
 *  router list is unreachable. Filtered to instruct/chat-flavoured ids so
 *  the picker stays usable for chat. */
async function fetchHubTrending(limit = 50): Promise<string[]> {
  const json = (await getJson(
    `https://huggingface.co/api/models?pipeline_tag=text-generation&sort=likes&direction=-1&limit=${limit}`,
    {},
  )) as Array<{ modelId?: string; id?: string }>
  const ids = (Array.isArray(json) ? json : [])
    .map((m) => m.modelId ?? m.id ?? "")
    .filter((v) => v.length > 0 && /instruct|chat|coder|it$/i.test(v))
  return [...new Set(ids)]
}

export interface KeyCheck {
  ok: boolean
  status?: number
  /** Actionable hint for 401s (permission/scope, not just "bad key"). */
  hint?: string
}

const KEY_401_HINTS: Record<string, string> = {
  huggingface:
    "HF router 401 with a working login usually = token scope: the token needs " +
    "'Make calls to Inference Providers' (https://huggingface.co/settings/tokens) " +
    "plus credits. A read-only token lists models fine but chat 401s.",
  nvidia: "NVIDIA 401 = key rejected: use a bare nvapi-… key (no 'NVAPI_KEY ' prefix) from build.nvidia.com.",
  "nvidia-nim": "NVIDIA 401 = key rejected: use a bare nvapi-… key (no 'NVAPI_KEY ' prefix) from build.nvidia.com.",
  openai: "OpenAI 401 = key rejected or no billing on the account.",
  anthropic: "Anthropic 401 = key rejected: check console.anthropic.com API keys.",
  google: "Google 400/401 = bad key or the Generative Language API is disabled for the project.",
  xai: "xAI 401 = key rejected: check console.x.ai API keys.",
  groq: "Groq 401 = key rejected: check console.groq.com API keys.",
  mistral: "Mistral 401 = key rejected: check console.mistral.ai API keys.",
  cerebras: "Cerebras 401 = key rejected: check cloud.cerebras.ai API keys.",
  together: "Together 401 = key rejected: check api.together.xyz API keys.",
  deepinfra: "DeepInfra 401 = key rejected: check deepinfra.com API keys.",
  cohere: "Cohere 401 = key rejected: check dashboard.cohere.com API keys.",
  perplexity: "Perplexity 401 = key rejected: check perplexity.ai API keys.",
  openrouter: "OpenRouter 401 = key rejected: check openrouter.ai API keys.",
  fireworks: "Fireworks 401 = key rejected: check fireworks.ai API keys.",
  venice: "Venice 401 = key rejected: check venice.ai API keys.",
  azure: "Azure 401 = key rejected or wrong deployment URL: check {resource}.openai.azure.com deployments.",
  "skt-gateway": "SKT Gateway 401 = key rejected: check the gateway API key.",
  ollama: "Ollama unreachable = is `ollama serve` running? Default http://localhost:11434, no key needed.",
}

/**
 * Honest credential check: one minimal 1-token chat ping against the real
 * chat endpoint. Model listing can succeed while chat 401s (e.g. an HF
 * read-only token), so only this proves the key can actually talk.
 */
export async function verifyProviderKey(
  providerId: string,
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<KeyCheck> {
  const id = providerId.toLowerCase()
  try {
    if (id === "anthropic") {
      const base = (baseUrl || "https://api.anthropic.com").replace(/\/+$/, "")
      const r = await postRaw(
        `${base}/v1/messages`,
        "POST",
        { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      )
      return r.status < 400
        ? { ok: true, status: r.status }
        : { ok: false, status: r.status, hint: r.status === 401 ? KEY_401_HINTS.anthropic : r.body }
    }
    if (id === "google") {
      const base = (baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "")
      const r = await postRaw(
        `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        "POST",
        { "Content-Type": "application/json" },
        JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
      )
      return r.status < 400
        ? { ok: true, status: r.status }
        : { ok: false, status: r.status, hint: r.status === 400 || r.status === 401 ? KEY_401_HINTS.google : r.body }
    }
    const base = (baseUrl || getCatalogEntry(id)?.defaultBaseUrl || "").replace(/\/+$/, "")
    if (!base) return { ok: false, hint: "No endpoint configured." }
    const r = await postRaw(
      `${base}/v1/chat/completions`,
      "POST",
      { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false }),
    )
    if (r.status < 400) return { ok: true, status: r.status }
    const hint401 = KEY_401_HINTS[id] ?? "Provider 401 = key rejected."
    return { ok: false, status: r.status, hint: r.status === 401 ? hint401 : r.body }
  } catch (err) {
    return { ok: false, hint: err instanceof Error ? err.message : String(err) }
  }
}
