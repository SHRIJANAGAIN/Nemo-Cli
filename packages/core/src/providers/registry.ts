/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { Provider, ProviderOptions } from "../../../../packages/provider/src/types.js"
import { createLlamaCppProvider, createNvidiaProvider } from "../../../../packages/provider/src/index.js"
import { createCustomProvider } from "../../../../packages/provider/src/custom.js"
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
  registry.register("ollama", (opts) => {
    return createOllamaProvider(opts)
  })
  registry.register("custom", (opts) => {
    return createCustomProvider(opts)
  })
  return registry
}
