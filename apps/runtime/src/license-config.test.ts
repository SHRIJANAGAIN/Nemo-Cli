/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { loadConfig } from "./config.js"

// License/secret fields ride env vars (never the shell history in tests):
// stubEnv keeps these hermetic regardless of the developer's machine.
afterEach(() => {
  vi.unstubAllEnvs()
})

describe("license config", () => {
  it("passes licenseKey + licenseServerUrl through from env", () => {
    vi.stubEnv("NEMO_LICENSE_KEY", "1102-XXXX-XXXX-XXXX")
    vi.stubEnv("NEMO_LICENSE_SERVER", "https://licenses.example.com")
    const cfg = loadConfig({ provider: "nvidia", baseUrl: "", model: "" })
    expect(cfg.licenseKey).toBe("1102-XXXX-XXXX-XXXX")
    expect(cfg.licenseServerUrl).toBe("https://licenses.example.com")
  })

  it("leaves licenseKey undefined when env is absent", () => {
    vi.stubEnv("NEMO_LICENSE_KEY", "")
    const cfg = loadConfig({ provider: "nvidia", baseUrl: "", model: "" })
    // Empty env counts as unset (falsy guard in the loader).
    expect(cfg.licenseKey ?? "").toBe("")
  })

  it("passes githubLogin through overrides (display identity, never a secret)", () => {
    const cfg = loadConfig({ provider: "nvidia", baseUrl: "", model: "", githubLogin: "octocat" })
    expect(cfg.githubLogin).toBe("octocat")
    const blank = loadConfig({ provider: "nvidia", baseUrl: "", model: "", githubLogin: "  " })
    expect(blank.githubLogin).toBeUndefined()
  })

  it("falls back out-of-range temperatures to the safe default (never the wild edge)", () => {
    // 2.7 used to clamp to 2.0 — technically in-range but sampling mush on
    // most models (and an NVIDIA 400 on old builds). Now it lands on the
    // default (0, deterministic) instead of the wildest allowed value.
    const base = { provider: "nvidia", baseUrl: "", model: "" } as const
    expect(loadConfig({ ...base, temperature: 2.7 }).temperature).toBe(0)
    expect(loadConfig({ ...base, temperature: -1 }).temperature).toBe(0)
    expect(loadConfig({ ...base, temperature: Number.NaN }).temperature).toBe(0)
    expect(loadConfig({ ...base, temperature: "garbage" as unknown as number }).temperature).toBe(0)
    vi.stubEnv("NEMO_TEMPERATURE", "2.7")
    expect(loadConfig({ ...base }).temperature).toBe(0)
    vi.unstubAllEnvs()
    // In-range values pass through untouched, including the 2.0 ceiling.
    expect(loadConfig({ ...base, temperature: 0.7 }).temperature).toBe(0.7)
    expect(loadConfig({ ...base, temperature: 2 }).temperature).toBe(2)
    expect(loadConfig({ ...base, temperature: 0 }).temperature).toBe(0)
  })
})
