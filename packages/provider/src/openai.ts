/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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
