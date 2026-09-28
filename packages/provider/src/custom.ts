/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { NvidiaProvider } from "./nvidia.js"
import type { Provider, ProviderOptions } from "./types.js"

/**
 * Bring-your-own OpenAI-compatible endpoint, VS Code BYOK custom-provider
 * port (extensions/copilot customOAIProvider): local gateways, proxies,
 * self-hosted vLLM shims. Identical SSE pipeline to NvidiaProvider with NO
 * opinionated defaults and NO reasoning params. Key is optional (many local
 * endpoints take none); the model comes from /v1/models or is typed
 * explicitly. A pasted full chat URL (.../v1/chat/completions) is folded
 * back to its base like resolveCustomOAIUrl.
 */
export class CustomProvider extends NvidiaProvider {
  readonly id = "custom"
  protected apiErrorPrefix = "Custom provider API"

  constructor(options: ProviderOptions) {
    super({
      ...options,
      baseUrl: normalizeCustomBaseUrl(
        options.baseUrl && options.baseUrl.length > 0 ? options.baseUrl : "http://localhost:8080",
      ),
      model: options.model ?? "",
    })
  }

  protected applyReasoning(_body: Record<string, unknown>): void {
    // Unknown endpoint — never guess provider-specific params.
  }
}

/** Fold a pasted chat URL back to its API base (unit-tested). */
export function normalizeCustomBaseUrl(raw: string): string {
  let base = raw.replace(/\/+$/, "")
  base = base.replace(/\/chat\/completions$/, "")
  base = base.replace(/\/responses$/, "")
  return base.length > 0 ? base : "http://localhost:8080"
}

export function createCustomProvider(options: ProviderOptions): Provider {
  return new CustomProvider(options)
}
