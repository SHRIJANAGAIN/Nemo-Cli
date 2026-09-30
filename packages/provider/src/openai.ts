/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { NvidiaProvider } from "./nvidia.js"
import type { Provider, ProviderOptions } from "./types.js"

/**
 * Streaming client for OpenAI's chat completions API
 * (https://api.openai.com/v1/chat/completions). OpenAI-compatible SSE —
 * shares the full streaming/retry/abort pipeline with NvidiaProvider.
 * Reasoning models take `reasoning_effort` (low/medium/high) instead of
 * NVIDIA's `reasoning_tokens`.
 */
export class OpenAIProvider extends NvidiaProvider {
  readonly id = "openai"
  protected apiErrorPrefix = "OpenAI API"

  constructor(options: ProviderOptions) {
    super({
      ...options,
      baseUrl: options.baseUrl && options.baseUrl.length > 0 ? options.baseUrl : "https://api.openai.com",
      model: options.model && options.model.length > 0 ? options.model : "gpt-4o",
    })
  }

  protected applyReasoning(body: Record<string, unknown>): void {
    if (!this.options.reasoningEffort) return
    const effort = this.options.reasoningEffort
    body.reasoning_effort = effort === "low" ? "low" : effort === "medium" ? "medium" : "high"
  }
}

export function createOpenAIProvider(options: ProviderOptions): Provider {
  return new OpenAIProvider(options)
}

/**
 * Generic OpenAI-compatible gateway provider (Groq/Mistral/Cerebras/
 * Together/DeepInfra/Cohere/Perplexity/OpenRouter/Fireworks/Venice/Azure/
 * SKT-Gateway). Reuses the full NvidiaProvider SSE/retry/abort pipeline
 * with no reasoning params — unknown gateways must never get
 * provider-specific fields (keeps gateways clear of 400s). The `id` is
 * carried per-gateway so audit/telemetry/registry stay truthful.
 */
export class OpenAICompatibleProvider extends NvidiaProvider {
  readonly id: string

  constructor(id: string, label: string, options: ProviderOptions, defaultBaseUrl: string, defaultModel: string) {
    super({
      ...options,
      baseUrl: options.baseUrl && options.baseUrl.length > 0 ? options.baseUrl : defaultBaseUrl,
      model: options.model && options.model.length > 0 ? options.model : defaultModel,
    })
    this.id = id
    this.apiErrorPrefix = `${label} API`
  }

  protected applyReasoning(_body: Record<string, unknown>): void {
    // Gateways proxy to many models — never guess reasoning params.
  }
}

export function createOpenAICompatibleProvider(
  id: string,
  label: string,
  defaultBaseUrl: string,
  defaultModel: string,
): (options: ProviderOptions) => Provider {
  return (options: ProviderOptions) => new OpenAICompatibleProvider(id, label, options, defaultBaseUrl, defaultModel)
}
