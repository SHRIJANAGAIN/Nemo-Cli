/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
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
