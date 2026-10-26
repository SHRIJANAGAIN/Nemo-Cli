/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { loadConfig, cleanApiKey } from "./config.js"

/**
 * Provider ids + endpoint defaults (nvidia/nvidia-nim alongside the local
 * runtimes and custom). Overrides pass explicit "" so the file-backed user
 * config can never leak in — assertions stay hermetic.
 */
describe("config provider ids", () => {
  it("whitelists the surviving ids and applies endpoint defaults", () => {
    const nim = loadConfig({ provider: "nvidia-nim", baseUrl: "", model: "" })
    expect(nim.provider).toBe("nvidia-nim")
    expect(nim.baseUrl).toBe("https://integrate.api.nvidia.com")
    expect(nim.model).toBe("nvidia/nemotron-3-super-120b-a12b")
    const nvidia = loadConfig({ provider: "nvidia", baseUrl: "", model: "" })
    expect(nvidia.provider).toBe("nvidia")
    expect(nvidia.baseUrl).toBe("https://integrate.api.nvidia.com")
    expect(nvidia.model).toBe("nvidia/nemotron-3-super-120b-a12b")
    const oll = loadConfig({ provider: "ollama", baseUrl: "", model: "" })
    expect(oll.provider).toBe("ollama")
    expect(oll.baseUrl).toBe("http://localhost:11434")
    expect(oll.model).toBe("llama3.1")
  })

  it("falls back to nvidia on unknown ids", () => {
    const bogus = loadConfig({ provider: "nope" as never, baseUrl: "", model: "" })
    expect(bogus.provider).toBe("nvidia")
  })

  it("keeps explicit user endpoints (never clobbers config)", () => {
    const custom = loadConfig({
      provider: "custom",
      baseUrl: "https://gateway.internal/v1",
      model: "team-model",
    })
    expect(custom.baseUrl).toBe("https://gateway.internal")
    expect(custom.model).toBe("team-model")
  })

  it("rejects the removed cloud backends (falls back to nvidia)", () => {
    for (const id of ["openai", "xai", "huggingface", "anthropic", "google", "nemo-gateway"]) {
      const cfg = loadConfig({ provider: id as never, baseUrl: "", model: "" })
      expect(cfg.provider, id).toBe("nvidia")
    }
  })

  it("strips pasted key prefixes (NVAPI_KEY/Bearer) that 401 every provider", () => {
    expect(cleanApiKey("NVAPI_KEY nvapi-abc123")).toBe("nvapi-abc123")
    expect(cleanApiKey("Bearer sk-abc")).toBe("sk-abc")
    expect(cleanApiKey("  hf_xyz  ")).toBe("hf_xyz")
    const cfg = loadConfig({ provider: "nvidia", baseUrl: "", model: "", apiKey: "NVAPI_KEY nvapi-abc123" })
    expect(cfg.apiKey).toBe("nvapi-abc123")
  })

  it("keeps the per-backend key store (providers[]) across loads", () => {
    const cfg = loadConfig({
      provider: "nvidia",
      baseUrl: "",
      model: "",
      apiKey: "",
      providers: [
        {
          id: "ollama",
          type: "ollama",
          label: "Ollama",
          baseUrl: "http://localhost:11434",
          apiKey: "Bearer hf_abc",
        },
      ],
    })
    expect(cfg.providers?.[0]?.apiKey).toBe("hf_abc")
    expect(cfg.providers?.[0]?.baseUrl).toBe("http://localhost:11434")
  })

  it("keeps the per-backend live model cache (modelCache) across loads", () => {
    const cfg = loadConfig({
      provider: "nvidia",
      baseUrl: "",
      model: "",
      apiKey: "",
      modelCache: { ollama: ["a/b", "c/d", 42 as never, ""], junk: "x" as never },
    })
    expect(cfg.modelCache?.ollama).toEqual(["a/b", "c/d"])
    expect(cfg.modelCache?.junk).toBeUndefined()
  })

  it("drops malformed MCP server specs instead of crashing later", () => {
    const cfg = loadConfig({
      provider: "nvidia",
      baseUrl: "",
      model: "",
      apiKey: "",
      mcpServers: {
        ok: { command: ["node", "s.js"] },
        web: { url: "https://x.test/mcp" },
        empty: {},
        both: { command: ["node"], url: "https://x.test/mcp" },
        badurl: { url: "not a url" },
        nocmd: { command: [] },
      } as never,
    })
    expect(Object.keys(cfg.mcpServers ?? {}).sort()).toEqual(["ok", "web"])
  })

  it("defaults checkpoints on, honours an explicit off", () => {
    expect(loadConfig({ provider: "nvidia", baseUrl: "", model: "", apiKey: "" }).checkpointsEnabled).toBe(true)
    expect(
      loadConfig({ provider: "nvidia", baseUrl: "", model: "", apiKey: "", checkpointsEnabled: false })
        .checkpointsEnabled,
    ).toBe(false)
  })

  it("defaults memory auto-extract on, honours an explicit off", () => {
    expect(loadConfig({ provider: "nvidia", baseUrl: "", model: "", apiKey: "" }).memoryAutoExtract).toBe(true)
    expect(
      loadConfig({ provider: "nvidia", baseUrl: "", model: "", apiKey: "", memoryAutoExtract: false })
        .memoryAutoExtract,
    ).toBe(false)
  })

  it("validates tool-call hook groups, dropping malformed entries", () => {
    const cfg = loadConfig({
      provider: "nvidia",
      baseUrl: "",
      model: "",
      apiKey: "",
      hooks: {
        preToolUse: [
          { matcher: "bash", hooks: [{ command: "check.sh", timeoutSec: 5 }] },
          { matcher: "x", hooks: [{ command: "" }, { timeoutSec: 3 } as never] },
          "junk" as never,
        ],
        postToolUse: "nope" as never,
      } as never,
    })
    expect(cfg.hooks?.preToolUse).toEqual([{ matcher: "bash", hooks: [{ command: "check.sh", timeoutSec: 5 }] }])
    expect(cfg.hooks?.postToolUse).toBeUndefined()
  })

  it("saveConfig drops a stale file key when env mode is active (no plaintext key at rest)", async () => {
    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const { saveConfig } = await import("./config.js")
    const prevCwd = process.cwd()
    const prevEnv = process.env.NEMO_API_KEY
    const prevConfig = process.env.NEMO_CONFIG
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-cfg-"))
    fs.mkdirSync(path.join(dir, ".nemo"), { recursive: true })
    process.env.NEMO_CONFIG = path.join(dir, ".nemo", "config.json")
    process.chdir(dir)
    try {
      // A key persisted before the user switched to env mode. (The `test`
      // marker keeps these fixtures inside the no-hardcoded-secrets
      // placeholder exemption, like the rest of the suite's fake keys.)
      const file = path.join(dir, ".nemo", "config.json")
      fs.writeFileSync(file, JSON.stringify({ provider: "nvidia", apiKey: "sk-test-stale-key-at-rest" }))
      // Env mode on: the file key is stale by definition (env wins at load),
      // so saving anything must scrub it rather than preserve it.
      process.env.NEMO_API_KEY = "sk-test-live-from-env"
      saveConfig({ provider: "nvidia" } as never)
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
      expect(saved.apiKey).toBeUndefined()
      expect(saved.provider).toBe("nvidia")
      // And without env mode, an explicit key still persists (login flow).
      delete process.env.NEMO_API_KEY
      saveConfig({ apiKey: "sk-test-explicit-login-key" } as never)
      const savedAgain = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
      expect(savedAgain.apiKey).toBe("sk-test-explicit-login-key")
    } finally {
      if (prevEnv === undefined) delete process.env.NEMO_API_KEY
      else process.env.NEMO_API_KEY = prevEnv
      if (prevConfig === undefined) delete process.env.NEMO_CONFIG
      else process.env.NEMO_CONFIG = prevConfig
      process.chdir(prevCwd)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("saveConfig never wipes the file on torn reads (backs corrupt JSON aside)", async () => {
    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const { saveConfig, loadConfig: reload } = await import("./config.js")
    const prevCwd = process.cwd()
    const prevConfig = process.env.NEMO_CONFIG
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-cfg-"))
    fs.mkdirSync(path.join(dir, ".nemo"), { recursive: true })
    process.env.NEMO_CONFIG = path.join(dir, ".nemo", "config.json")
    process.chdir(dir)
    try {
      saveConfig({ provider: "nvidia", model: "m1" } as never)
      // Simulate a crash mid-write: truncate the file to partial JSON.
      const file = path.join(dir, ".nemo", "config.json")
      const full = fs.readFileSync(file, "utf8")
      fs.writeFileSync(file, full.slice(0, Math.floor(full.length / 2)))
      saveConfig({ themeName: "candy-pop" } as never)
      const backups = fs.readdirSync(path.join(dir, ".nemo")).filter((f) => f.startsWith("config.json.corrupt-"))
      expect(backups.length).toBeGreaterThan(0)
      // New keys land; no torn temp file is left behind.
      expect(reload().themeName).toBe("candy-pop")
      expect(fs.existsSync(file + ".tmp-" + process.pid)).toBe(false)
    } finally {
      if (prevConfig === undefined) delete process.env.NEMO_CONFIG
      else process.env.NEMO_CONFIG = prevConfig
      process.chdir(prevCwd)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
