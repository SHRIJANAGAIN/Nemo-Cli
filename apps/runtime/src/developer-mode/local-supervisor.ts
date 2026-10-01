/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Local-LLM supervisor: a user-configured BACKEND decision model that
 * chooses the devmode penalty knobs (temperature / maxToolCalls /
 * webSearchFirst / clarificationRequired / stepByStep) for runs whose
 * PRIMARY model is a weak local sampler (ollama / llama.cpp).
 *
 * Scope rules:
 *  - Only ever consulted for local providers (the agent gates on
 *    `isLocalProvider` before calling in).
 *  - Every failure path — unconfigured, unknown provider id, timeout,
 *    abort, malformed reply — returns `null` (fail-open) so the existing
 *    heuristic penalty log keeps applying. The supervisor REPLACES
 *    heuristic values per key, it never adds to them.
 *  - All model access goes through `Provider` (registry factories), never
 *    a raw fetch.
 */

import { createProviderRegistry } from "../../../../packages/core/src/providers/registry.js"
import type { AssistantMessage } from "../../../../packages/protocol/src/index.js"
import type { Provider, ProviderOptions } from "../../../../packages/provider/src/types.js"

/** One penalty decision the backend LLM may return. All keys optional. */
export interface SupervisorDecision {
  /** Sampler temperature, clamped to [0, 2] (3-decimal, same convention as the heuristic). */
  temperature?: number
  /** Tool-call budget for the next turn, clamped to [1, 64]. */
  maxToolCalls?: number
  webSearchFirst?: boolean
  clarificationRequired?: boolean
  stepByStep?: boolean
  /** Short human-readable rationale (kept in memory only, never persisted or logged). */
  reason?: string
}

/**
 * Config for the backend decision model (`developerMode.localSupervisor`
 * in the config file). Empty provider/model means "not configured" — the
 * supervisor never runs and the heuristic penalties stay in charge.
 */
export interface LocalSupervisorConfig {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  timeoutMs: number
}

export const DEFAULT_LOCAL_SUPERVISOR_CONFIG: LocalSupervisorConfig = {
  provider: "",
  model: "",
  baseUrl: "",
  apiKey: "",
  timeoutMs: 15_000,
}

/** Minimal mistake shape sent to the supervisor (structural, not the engine record). */
export interface SupervisorMistake {
  type: string
  severity: number
  description: string
  resolved: boolean
  timestamp: number
}

/** How many recent mistakes the decision prompt carries (bound the payload). */
export const SUPERVISOR_MAX_HISTORY = 10

/** Ceiling on a single decision request. */
export const SUPERVISOR_MAX_TIMEOUT_MS = 120_000
export const SUPERVISOR_MIN_TIMEOUT_MS = 1_000

/**
 * Per-id base URLs used when the config leaves `baseUrl` empty. Mirrors
 * the defaults in `Agent.createProviderForConfig` (providers themselves
 * mostly do NOT default — an empty baseUrl reaches `new URL("")` and
 * throws at chat time). OpenAI-compatible gateways bake their own
 * default into the factory, so they are not listed here.
 */
const BASE_URL_DEFAULTS: Record<string, string> = {
  nvidia: "https://integrate.api.nvidia.com",
  "nvidia-nim": "https://integrate.api.nvidia.com",
  openai: "https://api.openai.com",
  xai: "https://api.x.ai",
  huggingface: "https://router.huggingface.co/v1",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com/v1beta",
  ollama: "http://localhost:11434",
  custom: "http://localhost:8080",
  llamacpp: "http://localhost:8080",
}

export function isSupervisorConfigured(cfg?: LocalSupervisorConfig): boolean {
  if (!cfg) return false
  return cfg.provider.trim().length > 0 && cfg.model.trim().length > 0
}

/**
 * Config rules: invalid values fall back to defaults, never throw.
 * Accepts a partial object (or anything else) from the config file.
 */
export function sanitizeSupervisorConfig(raw: unknown): LocalSupervisorConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_LOCAL_SUPERVISOR_CONFIG }
  }
  const rec = raw as Record<string, unknown>
  const str = (key: "provider" | "model" | "baseUrl" | "apiKey"): string => {
    const v = rec[key]
    return typeof v === "string" ? v : DEFAULT_LOCAL_SUPERVISOR_CONFIG[key]
  }
  const timeoutRaw = rec.timeoutMs
  const timeout =
    typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.min(SUPERVISOR_MAX_TIMEOUT_MS, Math.max(SUPERVISOR_MIN_TIMEOUT_MS, Math.round(timeoutRaw)))
      : DEFAULT_LOCAL_SUPERVISOR_CONFIG.timeoutMs
  return {
    provider: str("provider"),
    model: str("model"),
    baseUrl: str("baseUrl"),
    apiKey: str("apiKey"),
    timeoutMs: timeout,
  }
}

/**
 * Parse the supervisor's reply into a decision. Accepts a bare JSON
 * object, a ```json fenced block, or JSON embedded in prose. Anything
 * unparseable or with zero recognized keys returns `null` (fail-open).
 */
export function parseSupervisorDecision(text: string): SupervisorDecision | null {
  const stripped = text.replace(/```(?:json)?/gi, "").trim()
  let parsed: unknown = null
  try {
    parsed = JSON.parse(stripped)
  } catch {
    const start = stripped.indexOf("{")
    const end = stripped.lastIndexOf("}")
    if (start < 0 || end <= start) return null
    try {
      parsed = JSON.parse(stripped.slice(start, end + 1))
    } catch {
      return null
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const rec = parsed as Record<string, unknown>
  const decision: SupervisorDecision = {}

  const temp = rec.temperature
  if (typeof temp === "number" && Number.isFinite(temp)) {
    decision.temperature = +Math.min(2, Math.max(0, temp)).toFixed(3)
  }
  const tools = rec.maxToolCalls
  if (typeof tools === "number" && Number.isFinite(tools)) {
    decision.maxToolCalls = Math.min(64, Math.max(1, Math.round(tools)))
  }
  for (const key of ["webSearchFirst", "clarificationRequired", "stepByStep"] as const) {
    if (typeof rec[key] === "boolean") decision[key] = rec[key]
  }
  if (typeof rec.reason === "string") decision.reason = rec.reason.slice(0, 300)

  return decision.temperature !== undefined ||
    decision.maxToolCalls !== undefined ||
    decision.webSearchFirst !== undefined ||
    decision.clarificationRequired !== undefined ||
    decision.stepByStep !== undefined
    ? decision
    : null
}

const SYSTEM_PROMPT = [
  "You are the backend penalty decision-maker for a local LLM agent.",
  "The primary model runs on a weak LOCAL sampler (Ollama / llama.cpp); you choose",
  "the devmode penalty knobs for its next turn based on its recent mistake log.",
  "Respond with ONLY a JSON object, no prose, no markdown fence. All keys optional:",
  '- "temperature": number 0-2 (lower = more deterministic; repeated severe mistakes -> go lower)',
  '- "maxToolCalls": integer 1-64 (lower caps runaway tool loops)',
  '- "webSearchFirst": boolean',
  '- "clarificationRequired": boolean',
  '- "stepByStep": boolean',
  '- "reason": short string',
].join(" ")

export interface RequestSupervisorDecisionInput {
  supervisor: LocalSupervisorConfig
  mistakes: SupervisorMistake[]
  currentAdjustments: Record<string, number | string | boolean>
  /** Turn abort signal — raced against the supervisor's own timeout. */
  signal?: AbortSignal
  /** Injection seam for tests; defaults to the core provider registry. */
  createProvider?: (providerId: string, options: ProviderOptions) => Provider | undefined
}

/**
 * Ask the backend decision model for penalty overrides. Returns `null`
 * on every failure path so callers can keep the heuristic penalties.
 */
export async function requestSupervisorDecision(
  input: RequestSupervisorDecisionInput,
): Promise<SupervisorDecision | null> {
  try {
    const cfg = input.supervisor
    if (!isSupervisorConfigured(cfg)) return null
    const create =
      input.createProvider ??
      ((providerId: string, options: ProviderOptions): Provider | undefined =>
        createProviderRegistry().create(providerId, options))
    const id = cfg.provider.trim().toLowerCase()
    const baseUrl = cfg.baseUrl.trim().length > 0 ? cfg.baseUrl.trim() : (BASE_URL_DEFAULTS[id] ?? "")
    const provider = create(cfg.provider.trim(), {
      baseUrl,
      model: cfg.model.trim(),
      apiKey: cfg.apiKey.length > 0 ? cfg.apiKey : undefined,
      timeoutMs: cfg.timeoutMs,
      temperature: 0,
    })
    if (!provider) return null
    const recentMistakes = input.mistakes.slice(-SUPERVISOR_MAX_HISTORY).map((m) => ({
      type: m.type,
      severity: Math.min(5, Math.max(1, Math.round(m.severity))),
      description: m.description.slice(0, 200),
      resolved: m.resolved,
      timestamp: m.timestamp,
    }))
    const payload = JSON.stringify({
      currentAdjustments: input.currentAdjustments,
      recentMistakes,
    })
    const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs)
    const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal
    const message: AssistantMessage = await provider.chat({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: payload }],
      signal,
    })
    const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
    return parseSupervisorDecision(text)
  } catch {
    return null
  }
}
