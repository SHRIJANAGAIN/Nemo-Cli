/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Behavior tests for the stateless provider/model helpers extracted from
 * App.tsx (max-file-size rule).
 *
 * Fully deterministic: no network, no timers, no ambient state — every
 * config read/write is redirected to a temp file through NEMO_CONFIG,
 * which configPath() honors. If a case here needs the real user config to
 * pass, it is a bad test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  fetchWarn,
  providerHostFor,
  providerLabelFor,
  readStoredKey,
  resolveModels,
  themeToPickerOption,
  writeStoredKey,
} from "./provider-model-support.js"
import { listThemes } from "../ui/theme.js"

let tmpDir: string
let configFile: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-provider-support-"))
  configFile = path.join(tmpDir, "config.json")
  vi.stubEnv("NEMO_CONFIG", configFile)
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Persisted config as raw JSON ({} when nothing was written yet). */
function readConfig(): Record<string, unknown> {
  if (!fs.existsSync(configFile)) return {}
  return JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, unknown>
}

function readModelCache(): Record<string, string[]> {
  return (readConfig().modelCache ?? {}) as Record<string, string[]>
}

function readProviders(): Array<{ id?: string; type?: string; apiKey?: string; baseUrl?: string }> {
  return (readConfig().providers ?? []) as Array<{ id?: string; type?: string; apiKey?: string; baseUrl?: string }>
}

describe("themeToPickerOption", () => {
  it("maps a real theme to a picker row: name, humanized label, dark/light, hex swatch", () => {
    const theme = listThemes()[0]
    if (!theme) throw new Error("theme registry returned no themes")
    const option = themeToPickerOption(theme)

    expect(option.name).toBe(theme.name)
    // Label is the humanized name: same words, capitalized, space-separated.
    expect(option.label.toLowerCase().replace(/\s+/g, "-")).toBe(theme.name.toLowerCase())
    expect(option.description).toBe(theme.dark ? "dark" : "light")
    expect(option.swatch).toMatch(/^#[0-9a-f]{6}$/)
  })

  it("works for every theme in the registry (no missing colors blow up the picker)", () => {
    for (const theme of listThemes()) {
      const option = themeToPickerOption(theme)
      expect(option.swatch).toMatch(/^#[0-9a-f]{6}$/)
      expect(option.label.length).toBeGreaterThan(0)
    }
  })
})

describe("providerHostFor", () => {
  it("extracts the host from a base URL", () => {
    expect(providerHostFor("https://integrate.api.nvidia.com/v1")).toBe("integrate.api.nvidia.com")
    expect(providerHostFor("http://127.0.0.1:8080")).toBe("127.0.0.1:8080")
  })

  it("returns non-URL and scheme-less input unchanged instead of throwing or blanking it", () => {
    // Regression: `new URL("localhost:8080")` parses as protocol "localhost:"
    // with an empty host, so the catch never fired and the picker showed
    // nothing at all for a host:port the user had typed.
    expect(providerHostFor("localhost:8080")).toBe("localhost:8080")
    expect(providerHostFor("not a url")).toBe("not a url")
    expect(providerHostFor("")).toBe("")
  })
})

describe("fetchWarn", () => {
  it("stays silent on the happy path — no noise when nothing failed", () => {
    expect(fetchWarn()).toBe("")
    expect(fetchWarn(undefined)).toBe("")
  })

  it("names the 401 for an auth rejection and reachability for a network failure", () => {
    expect(fetchWarn("auth")).toContain("401")
    expect(fetchWarn("network")).toContain("unreachable")
  })
})

describe("providerLabelFor", () => {
  it("labels the custom endpoint explicitly", () => {
    expect(providerLabelFor("custom")).toBe("Custom endpoint")
  })

  it("falls back to a real provider name for an unknown id (never empty, never raw id)", () => {
    const label = providerLabelFor("totally-unknown-provider")
    expect(label.length).toBeGreaterThan(0)
    expect(label).not.toBe("totally-unknown-provider")
  })

  it("returns a non-empty label for the built-in providers", () => {
    for (const id of ["nvidia", "nvidia-nim", "ollama", "llamacpp", "custom"]) {
      expect(providerLabelFor(id).length).toBeGreaterThan(0)
    }
  })
})

describe("resolveModels and the model cache", () => {
  it("prefers a live list and persists it as the cache", () => {
    const result = resolveModels("custom", { models: ["m1", "m2"], source: "live" })
    expect(result).toEqual({ models: ["m1", "m2"], tag: "live" })
    expect(readModelCache().custom).toEqual(["m1", "m2"])
  })

  it("falls back to the cached list and says how many entries it is showing", () => {
    resolveModels("custom", { models: ["m1", "source"], source: "live" })
    const result = resolveModels("custom", { models: [], source: "fallback" })
    expect(result.models).toEqual(["m1", "source"])
    expect(result.tag).toBe("cached (2)")
  })

  it("reports an empty cache honestly instead of padding with the static catalog", () => {
    const result = resolveModels("custom", { models: [], source: "fallback", error: "network" })
    expect(result.models).toEqual([])
    expect(result.tag).toContain("no list")
    expect(result.tag).toContain("unreachable")
  })

  it("caches at most 150 models per provider", () => {
    const many = Array.from({ length: 200 }, (_, i) => `m${i}`)
    resolveModels("custom", { models: many, source: "live" })
    expect(readModelCache().custom).toHaveLength(150)
  })

  it("never writes an empty cache (a live-but-empty fetch must not leave a ghost entry)", () => {
    resolveModels("custom", { models: [], source: "live" })
    expect(readConfig().modelCache).toBeUndefined()
  })

  it("keys the cache case-insensitively so Custom and custom share one list", () => {
    resolveModels("CUSTOM", { models: ["m1"], source: "live" })
    expect(readModelCache().custom).toEqual(["m1"])
  })
})

describe("per-backend key memory", () => {
  it("stores a key and reads it back", () => {
    writeStoredKey("custom", "Bearer sk-secret-123", "https://api.example.dev/v1")
    expect(readStoredKey("custom")).toEqual({
      apiKey: "sk-secret-123",
      baseUrl: "https://api.example.dev/v1",
    })
  })

  it("strips auth prefixes before persisting (the raw Bearer form is never stored)", () => {
    writeStoredKey("custom", "Bearer sk-clean", "https://a.dev")
    expect(readProviders()[0]?.apiKey).toBe("sk-clean")
  })

  it("keeps every backend's key when switching back and forth — no keyless reset", () => {
    writeStoredKey("nvidia", "nvapi-test", "https://integrate.api.nvidia.com/v1")
    writeStoredKey("custom", "sk-custom", "https://api.example.dev/v1")
    expect(readStoredKey("nvidia").apiKey).toBe("nvapi-test")
    expect(readStoredKey("custom").apiKey).toBe("sk-custom")

    // Rewriting one backend must merge, not replace the list.
    writeStoredKey("nvidia", "nvapi-test-2", "https://integrate.api.nvidia.com/v1")
    expect(readStoredKey("nvidia").apiKey).toBe("nvapi-test-2")
    expect(readStoredKey("custom").apiKey).toBe("sk-custom")
  })

  it("updates in place instead of appending a duplicate row", () => {
    writeStoredKey("custom", "sk-1", "https://a.dev")
    writeStoredKey("custom", "sk-2", "https://b.dev")
    expect(readProviders().filter((p) => p.id === "custom")).toHaveLength(1)
    expect(readStoredKey("custom")).toEqual({ apiKey: "sk-2", baseUrl: "https://b.dev" })
  })

  it("caps the stored provider list at 20 rows", () => {
    for (let i = 0; i < 25; i++) writeStoredKey(`p${i}`, `sk-${i}`, `https://${i}.dev`)
    expect(readProviders().length).toBeLessThanOrEqual(20)
  })

  it("returns empty strings for an unknown provider instead of crashing", () => {
    expect(readStoredKey("never-configured")).toEqual({ apiKey: "", baseUrl: "" })
  })
})
