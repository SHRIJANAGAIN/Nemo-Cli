/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as http from "http"
import * as https from "https"
import * as url from "url"
import { trimTrailingSlashes } from "./base-url.js"

export type ProviderId = "llamacpp" | "nvidia" | "nvidia-nim" | "ollama" | "custom"

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
    // Local llama.cpp server. The model name is whatever the server has
    // loaded, so there is no static list to offer.
    id: "llamacpp",
    label: "llama.cpp",
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
    id: "custom",
    label: "Custom endpoint",
    defaultBaseUrl: "http://localhost:8080",
    defaultModel: "",
    needsBaseUrl: true,
    needsApiKey: false,
    keyOptional: true,
    staticModels: [],
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
    if (id === "ollama") {
      // Ollama-native list (VS Code ollamaProvider: GET {url}/api/tags).
      // No key; a stopped server falls through to statics via fail().
      const base = trimTrailingSlashes(baseUrl || "http://localhost:11434")
      const json = (await getJson(`${base}/api/tags`, {})) as {
        models?: Array<{ name?: string; model?: string }>
      }
      const ids = (json.models ?? []).map((m) => m.name ?? m.model ?? "").filter((v) => v.length > 0)
      return ids.length > 0 ? { models: ids, source: "live" } : fail("empty")
    }
    const base = trimTrailingSlashes(baseUrl || entry?.defaultBaseUrl || "")
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

export interface KeyCheck {
  ok: boolean
  status?: number
  /** Actionable hint for 401s (permission/scope, not just "bad key"). */
  hint?: string
}

const KEY_401_HINTS: Record<string, string> = {
  nvidia: "NVIDIA 401 = key rejected: use a bare nvapi-… key (no 'NVAPI_KEY ' prefix) from build.nvidia.com.",
  "nvidia-nim": "NVIDIA 401 = key rejected: use a bare nvapi-… key (no 'NVAPI_KEY ' prefix) from build.nvidia.com.",
  ollama: "Ollama unreachable = is `ollama serve` running? Default http://localhost:11434, no key needed.",
  llamacpp: "llama.cpp unreachable = is the server running? Default http://localhost:8080, no key needed.",
  custom: "Custom endpoint unreachable = check the base URL and that the server is running.",
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
    const base = trimTrailingSlashes(baseUrl || getCatalogEntry(id)?.defaultBaseUrl || "")
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
