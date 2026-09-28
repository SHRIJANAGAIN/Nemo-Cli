/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { NvidiaProvider } from "./nvidia.js"
import type { Provider, ProviderOptions } from "./types.js"

/**
 * Streaming client for Hugging Face Inference Providers
 * (https://router.huggingface.co/v1/chat/completions). OpenAI-compatible
 * SSE — shares the full streaming/retry/abort pipeline with NvidiaProvider.
 * Auth is a Bearer HF token; the model id selects the backing provider
 * (e.g. meta-llama/Llama-3.3-70B-Instruct). No reasoning params are sent.
 */
export class HuggingFaceProvider extends NvidiaProvider {
  readonly id = "huggingface"
  protected apiErrorPrefix = "Hugging Face API"

  constructor(options: ProviderOptions) {
    super({
      ...options,
      baseUrl: options.baseUrl && options.baseUrl.length > 0 ? options.baseUrl : "https://router.huggingface.co/v1",
      model: options.model && options.model.length > 0 ? options.model : "meta-llama/Llama-3.3-70B-Instruct",
    })
  }

  protected applyReasoning(_body: Record<string, unknown>): void {
    // Routing target decides reasoning support — send none by default.
  }
}

export function createHuggingFaceProvider(options: ProviderOptions): Provider {
  return new HuggingFaceProvider(options)
}
