/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, it, expect } from "vitest"
import { validateConfig, assertConfig } from "./index.js"
import type { TrayambakConfig } from "../../../apps/runtime/src/index.js"

const validConfig: TrayambakConfig = {
  baseUrl: "https://api.openai.com",
  model: "gpt-4",
  apiKey: "sk-test",
  cwd: "/tmp",
  temperature: 0.7,
  topP: 1,
  maxTokens: 1000,
  timeoutMs: 30000,
  shellCommand: "bash -c",
  maxOutputLines: 2000,
  maxOutputBytes: 256000,
  maxTurns: 64,
  maxToolCalls: 100,
  maxDistinctToolCalls: 1000,
  toolCallRate: 2,
  maxRetries: 2,
  retryDelayMs: 750,
  maxParallelToolCalls: 4,
  nativeTools: true,
}

describe("validateConfig", () => {
  it("returns empty errors for a valid config", () => {
    expect(validateConfig(validConfig)).toEqual([])
  })

  it("rejects a missing baseUrl", () => {
    const c = { ...validConfig, baseUrl: "" }
    const errs = validateConfig(c)
    expect(errs.some((e) => e.field === "baseUrl")).toBe(true)
  })

  it("rejects a non-http baseUrl", () => {
    const c = { ...validConfig, baseUrl: "ftp://bad" }
    const errs = validateConfig(c)
    expect(errs.some((e) => e.field === "baseUrl")).toBe(true)
  })

  it("rejects an empty model", () => {
    const c = { ...validConfig, model: "" }
    const errs = validateConfig(c)
    expect(errs.some((e) => e.field === "model")).toBe(true)
  })

  it("rejects temperature out of range", () => {
    const c = { ...validConfig, temperature: 5 }
    const errs = validateConfig(c)
    expect(errs.some((e) => e.field === "temperature")).toBe(true)
  })

  it("rejects non-positive maxTokens", () => {
    const c = { ...validConfig, maxTokens: 0 }
    const errs = validateConfig(c)
    expect(errs.some((e) => e.field === "maxTokens")).toBe(true)
  })
})

describe("assertConfig", () => {
  it("does not throw for a valid config", () => {
    expect(() => assertConfig(validConfig)).not.toThrow()
  })

  it("throws for an invalid config", () => {
    const c = { ...validConfig, baseUrl: "" }
    expect(() => assertConfig(c)).toThrow("Invalid configuration")
  })
})
