/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { NvidiaProvider } from "./nvidia.js"
import type { Provider, ProviderOptions } from "./types.js"

/**
 * Ollama backend port (extensions/copilot BYOK ollamaProvider): local
 * server, default http://localhost:11434, NO api key. Chat is
 * OpenAI-compatible ({base}/v1/chat/completions, served by Ollama ≥ 0.6);
 * the model list is Ollama-native (GET {base}/api/tags — see catalog).
 */
export class OllamaProvider extends NvidiaProvider {
  readonly id = "ollama"
  protected apiErrorPrefix = "Ollama API"

  constructor(options: ProviderOptions) {
    super({
      ...options,
      baseUrl: options.baseUrl && options.baseUrl.length > 0 ? options.baseUrl : "http://localhost:11434",
      model: options.model && options.model.length > 0 ? options.model : "llama3.1",
    })
  }

  protected applyReasoning(_body: Record<string, unknown>): void {
    // Ollama takes no reasoning tuning params — send none.
  }
}

export function createOllamaProvider(options: ProviderOptions): Provider {
  return new OllamaProvider(options)
}
