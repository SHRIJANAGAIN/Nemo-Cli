/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { NvidiaProvider } from "./nvidia.js"
import type { Provider, ProviderOptions } from "./types.js"

/**
 * Streaming client for xAI's Grok API (https://api.x.ai/v1/chat/completions).
 * OpenAI-compatible SSE — shares the full streaming/retry/abort pipeline
 * with NvidiaProvider. No provider-specific reasoning params are sent.
 */
export class XAIProvider extends NvidiaProvider {
  readonly id = "xai"
  protected apiErrorPrefix = "xAI API"

  constructor(options: ProviderOptions) {
    super({
      ...options,
      baseUrl: options.baseUrl && options.baseUrl.length > 0 ? options.baseUrl : "https://api.x.ai",
      model: options.model && options.model.length > 0 ? options.model : "grok-4",
    })
  }

  protected applyReasoning(_body: Record<string, unknown>): void {
    // xAI takes no reasoning tuning params on chat completions — send none
    // (keeps Grok models clear of unknown-parameter 400s).
  }
}

export function createXAIProvider(options: ProviderOptions): Provider {
  return new XAIProvider(options)
}
