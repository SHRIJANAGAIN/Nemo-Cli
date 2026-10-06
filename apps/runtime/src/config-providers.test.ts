/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { loadConfig, cleanApiKey } from "./config.js"

/**
 * Provider ids + endpoint defaults (openai/xai/huggingface/custom alongside
 * llamacpp/nvidia). Overrides pass explicit "" so the file-backed user
 * config can never leak in — assertions stay hermetic.
 */
describe("config provider ids", () => {
  it("whitelists new ids and applies endpoint defaults", () => {
    const xai = loadConfig({ provider: "xai", baseUrl: "", model: "" })
    expect(xai.provider).toBe("xai")
    expect(xai.baseUrl).toBe("https://api.x.ai")
    expect(xai.model).toBe("grok-4")
    const openai = loadConfig({ provider: "openai", baseUrl: "", model: "" })
    expect(openai.baseUrl).toBe("https://api.openai.com")
    expect(openai.model).toBe("gpt-4o")
    const hf = loadConfig({ provider: "huggingface", baseUrl: "", model: "" })
    expect(hf.baseUrl).toBe("https://router.huggingface.co")
    expect(hf.model).toBe("meta-llama/Llama-3.3-70B-Instruct")
  })

  it("falls back to google on unknown ids", () => {
    const bogus = loadConfig({ provider: "nope" as never, baseUrl: "", model: "" })
    expect(bogus.provider).toBe("google")
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

  it("whitelists anthropic/google/nvidia-nim with endpoint defaults", () => {
    const anth = loadConfig({ provider: "anthropic", baseUrl: "", model: "" })
    expect(anth.provider).toBe("anthropic")
    expect(anth.baseUrl).toBe("https://api.anthropic.com")
    expect(anth.model).toBe("claude-3-5-sonnet-latest")
    const goog = loadConfig({ provider: "google", baseUrl: "", model: "" })
    expect(goog.provider).toBe("google")
    expect(goog.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta")
    expect(goog.model).toBe("gemini-2.5-flash")
    const nim = loadConfig({ provider: "nvidia-nim", baseUrl: "", model: "" })
    expect(nim.provider).toBe("nvidia-nim")
    expect(nim.baseUrl).toBe("https://integrate.api.nvidia.com")
    const oll = loadConfig({ provider: "ollama", baseUrl: "", model: "" })
    expect(oll.provider).toBe("ollama")
    expect(oll.baseUrl).toBe("http://localhost:11434")
    expect(oll.model).toBe("llama3.1")
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
          id: "huggingface",
          type: "huggingface",
          label: "Hugging Face",
          baseUrl: "https://router.huggingface.co/v1",
          apiKey: "Bearer hf_abc",
        },
      ],
    })
    expect(cfg.providers?.[0]?.apiKey).toBe("hf_abc")
    expect(cfg.providers?.[0]?.baseUrl).toBe("https://router.huggingface.co/v1")
  })

  it("keeps the per-backend live model cache (modelCache) across loads", () => {
    const cfg = loadConfig({
      provider: "nvidia",
      baseUrl: "",
      model: "",
      apiKey: "",
      modelCache: { huggingface: ["a/b", "c/d", 42 as never, ""], junk: "x" as never },
    })
    expect(cfg.modelCache?.huggingface).toEqual(["a/b", "c/d"])
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
    const prevEnv = process.env.TRAYAMBAK_API_KEY
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-cfg-"))
    fs.mkdirSync(path.join(dir, ".trayambak"), { recursive: true })
    process.chdir(dir)
    try {
      // A key persisted before the user switched to env mode. (The `test`
      // marker keeps these fixtures inside the no-hardcoded-secrets
      // placeholder exemption, like the rest of the suite's fake keys.)
      const file = path.join(dir, ".trayambak", "config.json")
      fs.writeFileSync(file, JSON.stringify({ provider: "nvidia", apiKey: "sk-test-stale-key-at-rest" }))
      // Env mode on: the file key is stale by definition (env wins at load),
      // so saving anything must scrub it rather than preserve it.
      process.env.TRAYAMBAK_API_KEY = "sk-test-live-from-env"
      saveConfig({ provider: "nvidia" } as never)
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
      expect(saved.apiKey).toBeUndefined()
      expect(saved.provider).toBe("nvidia")
      // And without env mode, an explicit key still persists (login flow).
      delete process.env.TRAYAMBAK_API_KEY
      saveConfig({ apiKey: "sk-test-explicit-login-key" } as never)
      const savedAgain = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
      expect(savedAgain.apiKey).toBe("sk-test-explicit-login-key")
    } finally {
      if (prevEnv === undefined) delete process.env.TRAYAMBAK_API_KEY
      else process.env.TRAYAMBAK_API_KEY = prevEnv
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-cfg-"))
    // Pre-create the local dir so configDir() picks it (never $HOME).
    fs.mkdirSync(path.join(dir, ".trayambak"), { recursive: true })
    process.chdir(dir)
    try {
      saveConfig({ provider: "nvidia", model: "m1" } as never)
      // Simulate a crash mid-write: truncate the file to partial JSON.
      const file = path.join(dir, ".trayambak", "config.json")
      const full = fs.readFileSync(file, "utf8")
      fs.writeFileSync(file, full.slice(0, Math.floor(full.length / 2)))
      saveConfig({ themeName: "candy-pop" } as never)
      const backups = fs.readdirSync(path.join(dir, ".trayambak")).filter((f) => f.startsWith("config.json.corrupt-"))
      expect(backups.length).toBeGreaterThan(0)
      // New keys land; no torn temp file is left behind.
      expect(reload().themeName).toBe("candy-pop")
      expect(fs.existsSync(file + ".tmp-" + process.pid)).toBe(false)
    } finally {
      process.chdir(prevCwd)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
