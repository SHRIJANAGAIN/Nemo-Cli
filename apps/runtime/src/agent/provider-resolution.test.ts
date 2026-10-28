/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Provider resolution: every catalog id must reach the backend it names.
 *
 * The bug this file exists for: `createProviderForConfig` ended in an
 * unconditional `createLlamaCppProvider(options)`, so all twelve OpenAI-compatible
 * catalog ids — groq, mistral, cerebras, together, deepinfra, cohere, perplexity,
 * openrouter, fireworks, venice, azure, nemo-gateway — silently sent their request
 * to the DEFAULT LLAMA.CPP ENDPOINT. A user who picked Groq got a connection
 * error against localhost and no mention of Groq, which reads as "Groq is down".
 *
 * Nemo now ships one cloud backend (NVIDIA) plus the local runtimes and a
 * user-supplied endpoint. The invariant that survives the cut is the same:
 * a catalog id must never resolve to a different provider's endpoint.
 */

import { describe, expect, it } from "vitest"
import { getCatalogEntry, PROVIDER_CATALOG } from "../../../../packages/provider/src/index.js"

describe("catalog coverage", () => {
  it("every catalog id is one of the surviving backends", () => {
    const expected = new Set(["llamacpp", "nvidia", "nvidia-nim", "ollama", "custom"])
    const unexpected: string[] = []
    for (const entry of PROVIDER_CATALOG) {
      if (!expected.has(entry.id)) unexpected.push(entry.id)
    }
    expect(unexpected).toEqual([])
    expect(PROVIDER_CATALOG.length).toBe(expected.size)
  })

  it("every catalog entry has a default base URL", () => {
    for (const entry of PROVIDER_CATALOG) {
      expect(entry.defaultBaseUrl.length, entry.id).toBeGreaterThan(0)
    }
  })

  it("a remote catalog entry is never marked keyOptional", () => {
    // keyOptional means "the key prompt is skippable"; a remote endpoint that
    // lets the user proceed keyless answers 401 with a model-shaped error.
    for (const entry of PROVIDER_CATALOG) {
      if (entry.keyOptional !== true) continue
      expect(/localhost|127\.0\.0\.1/.test(entry.defaultBaseUrl), entry.id).toBe(true)
    }
  })

  it("every catalog id can be looked up", () => {
    for (const entry of PROVIDER_CATALOG) {
      expect(getCatalogEntry(entry.id)?.id, entry.id).toBe(entry.id)
    }
  })
})

describe("no spec-driven gateways remain", () => {
  it("the removed cloud backends are gone from the catalog", () => {
    for (const id of [
      "openai",
      "xai",
      "huggingface",
      "anthropic",
      "google",
      "groq",
      "mistral",
      "cerebras",
      "together",
      "deepinfra",
      "cohere",
      "perplexity",
      "openrouter",
      "fireworks",
      "venice",
      "azure",
      "nemo-gateway",
    ]) {
      expect(getCatalogEntry(id), id).toBeUndefined()
    }
  })
})
