/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildCompletionsUrl, saveAgentProfile, type GeneratedAgent } from "./generate-agent.js"

/**
 * Regression: `saveAgentProfile` joined a model-controlled `identifier`
 * into `.trayambak/agents/<identifier>.md`. An explicit `name` argument
 * bypassed slugify, so `..\..\evil` wrote outside the project and a
 * newline-bearing name broke (or injected into) the YAML frontmatter.
 */
describe("saveAgentProfile containment", () => {
  const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const created: string[] = []
  const tmpDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `genagent-${tag}-`))
    created.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of created.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best-effort cleanup */
      }
    }
  })

  const agent = (identifier: string): GeneratedAgent => ({
    identifier,
    whenToUse: "Use when testing containment.",
    systemPrompt: "You are a test agent.",
  })

  it("throws on a traversal identifier and writes nothing", () => {
    const cwd = tmpDir()
    expect(() => saveAgentProfile(agent(`..\\..\\evil-${tag}`), cwd)).toThrow(/invalid agent identifier/)
    expect(fs.readdirSync(cwd)).toEqual([])
    expect(fs.existsSync(path.join(cwd, "..", "..", `evil-${tag}.md`))).toBe(false)
  })

  it("refuses control characters that would inject into the YAML frontmatter", () => {
    const cwd = tmpDir()
    expect(() => saveAgentProfile(agent(`bad\nname-${tag}`), cwd)).toThrow(/invalid agent identifier/)
    expect(fs.readdirSync(cwd)).toEqual([])
  })

  it("writes a valid profile under the project", () => {
    const cwd = tmpDir()
    const file = saveAgentProfile(agent(`ok-agent-${tag}`), cwd)
    expect(file).toBe(path.join(cwd, ".trayambak", "agents", `ok-agent-${tag}.md`))
    const text = fs.readFileSync(file, "utf8")
    expect(text).toContain(`name: ok-agent-${tag}`)
    expect(text).toContain("You are a test agent.")
  })

  it("collapses newlines in model-supplied frontmatter fields (no key breakout)", () => {
    // `parseAgentFile` splits frontmatter on \n into `key: value`: a raw
    // newline in `model`/`tools`/`whenToUse` would persist as attacker-chosen
    // YAML for later runs. Every frontmatter line must stay single-line.
    const cwd = tmpDir()
    const file = saveAgentProfile(
      {
        identifier: `fm-agent-${tag}`,
        whenToUse: `Use it.\r\n---\r\ninjected: true`,
        systemPrompt: "You are a test agent.",
        model: `some-model\ninjected: true`,
        tools: ["read", `write\ninjected: true`],
      },
      cwd,
    )
    const text = fs.readFileSync(file, "utf8")
    const block = text.slice(3, text.indexOf("---", 3))
    for (const line of block.split("\n")) {
      if (line.trim().length === 0) continue
      expect(line).not.toContain("injected")
      expect(line).toMatch(/^[^:\r\n]+: [^\r\n]*$/)
    }
    expect(text).toContain("model: some-model injected: true")
    expect(text).toContain("You are a test agent.")
  })
})

describe("buildCompletionsUrl", () => {
  it("keeps the base URL path and the /v1 endpoint for OpenAI-compatible servers", () => {
    // The old code rebuilt from `url.origin`, dropping any base path, and
    // gave non-NVIDIA hosts bare `/chat/completions` — every operator who set
    // a `…/v1` base (OpenAI's own, proxies) hit a 404.
    expect(buildCompletionsUrl("http://localhost:8080")).toBe("http://localhost:8080/v1/chat/completions")
    expect(buildCompletionsUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/chat/completions")
    expect(buildCompletionsUrl("https://proxy.example/llm/v1")).toBe("https://proxy.example/llm/v1/chat/completions")
    expect(buildCompletionsUrl("https://integrate.api.nvidia.com/v1")).toBe(
      "https://integrate.api.nvidia.com/v1/chat/completions",
    )
    expect(buildCompletionsUrl("https://host.example/v1/")).toBe("https://host.example/v1/chat/completions")
  })
})
