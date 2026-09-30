/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { Provider, ProviderOptions } from "../../../../packages/provider/src/types.js"
import { createLlamaCppProvider, createNvidiaProvider } from "../../../../packages/provider/src/index.js"
import { createOpenAIProvider, createOpenAICompatibleProvider } from "../../../../packages/provider/src/openai.js"
import { createXAIProvider } from "../../../../packages/provider/src/xai.js"
import { createHuggingFaceProvider } from "../../../../packages/provider/src/huggingface.js"
import { createCustomProvider } from "../../../../packages/provider/src/custom.js"
import { createAnthropicProvider } from "../../../../packages/provider/src/anthropic.js"
import { createGoogleProvider } from "../../../../packages/provider/src/google.js"
import { createOllamaProvider } from "../../../../packages/provider/src/ollama.js"

export interface ProviderEntry {
  id: string
  type: string
  label: string
  baseUrl: string
  apiKey?: string
  model?: string
  temperature?: number
  topP?: number
  maxTokens?: number
  timeoutMs?: number
  reasoningEffort?: ProviderOptions["reasoningEffort"]
  chatTemplateKwargs?: Record<string, unknown>
}

export type ProviderFactory = (options: ProviderOptions) => Provider

export class ProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>()

  register(type: string, factory: ProviderFactory): ProviderRegistry {
    this.factories.set(type.toLowerCase(), factory)
    return this
  }

  create(type: string, options: ProviderOptions): Provider | undefined {
    const factory = this.factories.get(type.toLowerCase())
    if (!factory) return undefined
    return factory(options)
  }

  has(type: string): boolean {
    return this.factories.has(type.toLowerCase())
  }

  types(): string[] {
    return Array.from(this.factories.keys())
  }
}

export function createProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry()
  registry.register("llamacpp", (opts) => {
    return createLlamaCppProvider(opts)
  })
  registry.register("nvidia", (opts) => {
    return createNvidiaProvider(opts)
  })
  registry.register("nvidia-nim", (opts) => {
    return createNvidiaProvider(opts)
  })
  registry.register("openai", (opts) => {
    return createOpenAIProvider(opts)
  })
  registry.register("xai", (opts) => {
    return createXAIProvider(opts)
  })
  registry.register("huggingface", (opts) => {
    return createHuggingFaceProvider(opts)
  })
  registry.register("anthropic", (opts) => {
    return createAnthropicProvider(opts)
  })
  registry.register("google", (opts) => {
    return createGoogleProvider(opts)
  })
  registry.register("ollama", (opts) => {
    return createOllamaProvider(opts)
  })
  registry.register("custom", (opts) => {
    return createCustomProvider(opts)
  })
  const gateways: Array<[id: string, label: string, base: string, model: string]> = [
    ["groq", "Groq API", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"],
    ["mistral", "Mistral API", "https://api.mistral.ai/v1", "mistral-large-latest"],
    ["cerebras", "Cerebras API", "https://api.cerebras.ai/v1", "llama3.1-70b"],
    ["together", "Together API", "https://api.together.xyz/v1", "meta-llama/Llama-3.3-70B-Instruct-Turbo"],
    ["deepinfra", "DeepInfra API", "https://api.deepinfra.com/v1/openai", "meta-llama/Llama-3.3-70B-Instruct"],
    ["cohere", "Cohere API", "https://api.cohere.com/compatibility/v1", "command-r-plus"],
    ["perplexity", "Perplexity API", "https://api.perplexity.ai", "sonar-pro"],
    ["openrouter", "OpenRouter API", "https://openrouter.ai/api/v1", "anthropic/claude-sonnet-4"],
    [
      "fireworks",
      "Fireworks API",
      "https://api.fireworks.ai/inference/v1",
      "accounts/fireworks/models/llama-v3p3-70b-instruct",
    ],
    ["venice", "Venice API", "https://api.venice.ai/api/v1", "llama-3.3-70b"],
    ["azure", "Azure OpenAI API", "https://YOUR-RESOURCE.openai.azure.com/openai/deployments", "gpt-4o"],
    ["skt-gateway", "SKT Gateway API", "https://gateway.skt-ai-labs.example/v1", "auto"],
  ]
  for (const [id, label, base, model] of gateways) {
    registry.register(id, createOpenAICompatibleProvider(id, label, base, model))
  }
  return registry
}
