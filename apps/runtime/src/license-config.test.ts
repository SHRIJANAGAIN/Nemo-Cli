/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { loadConfig } from "./config.js"

// License/secret fields ride env vars (never the shell history in tests):
// stubEnv keeps these hermetic regardless of the developer's machine.
afterEach(() => {
  vi.unstubAllEnvs()
})

interface StubSeen {
  verify: number
  usage: Array<Record<string, unknown>>
}

/** Tiny in-test license server: implements /license/verify + /license/usage
 *  with fixed verdicts. No cross-package import (runtime tests must not
 *  depend on packages/server) and no network beyond loopback. */
async function stubLicenseServer(opts: {
  valid: boolean
  plan?: string
  reason?: string
}): Promise<{ url: string; seen: StubSeen; close: () => Promise<void> }> {
  const seen: StubSeen = { verify: 0, usage: [] }
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => {
      body += c.toString()
    })
    req.on("end", () => {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(body) as Record<string, unknown>
      } catch {
        // Keep the stub strict-shaped; malformed bodies are a 400.
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "bad json" }))
        return
      }
      if (req.url === "/license/verify") {
        seen.verify += 1
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify(
            opts.valid
              ? { valid: true, plan: opts.plan ?? "pentest", exp: 1893456000 }
              : { valid: false, reason: opts.reason ?? "unknown license (not issued by SKT)" },
          ),
        )
        return
      }
      if (req.url === "/license/usage") {
        seen.usage.push(parsed)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "not found" }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  }
}

function tmpMachineFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), "lic-mid-")), "machine-id")
  vi.stubEnv("TRAYAMBAK_MACHINE_ID_FILE", path)
  return path
}

describe("license config", () => {
  it("passes licenseKey + licenseServerUrl through from env", () => {
    vi.stubEnv("TRAYAMBAK_LICENSE_KEY", "1102-XXXX-XXXX-XXXX")
    vi.stubEnv("TRAYAMBAK_LICENSE_SERVER", "https://licenses.example.com")
    const cfg = loadConfig({ provider: "nvidia", baseUrl: "", model: "" })
    expect(cfg.licenseKey).toBe("1102-XXXX-XXXX-XXXX")
    expect(cfg.licenseServerUrl).toBe("https://licenses.example.com")
  })

  it("leaves licenseKey undefined when env is absent", () => {
    vi.stubEnv("TRAYAMBAK_LICENSE_KEY", "")
    const cfg = loadConfig({ provider: "nvidia", baseUrl: "", model: "" })
    // Empty env counts as unset (falsy guard in the loader).
    expect(cfg.licenseKey ?? "").toBe("")
  })

  it("refuses pentest execution when the license server is unreachable (fail closed)", async () => {
    tmpMachineFile()
    const { createDefaultTools } = await import("./tools/index.js")
    // Nothing listens on port 1 — the gate must refuse, never fail open.
    const closed = createDefaultTools(undefined, undefined, undefined, undefined, {
      licenseKey: "1102-AAAA-BBBB-CCCC",
      licenseServerUrl: "http://127.0.0.1:1",
      cwd: process.cwd(),
    } as never)
    const pentest = closed.tools.find((t) => t.definition.name === "trayambak__PentestRunTool")
    expect(pentest).toBeDefined()
    const result = await pentest!.execute("c1", { toolName: "nmap", target: "example.com" }, undefined)
    expect(result.isError).toBe(true)
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("")
    expect(text).toContain("refused")
    expect(text).toContain("unreachable")
    // …while ordinary tools are untouched.
    expect(closed.tools.some((t) => t.definition.name === "todo")).toBe(true)
  }, 60000)

  it("refuses forged keys with the server's reason", async () => {
    tmpMachineFile()
    const stub = await stubLicenseServer({ valid: false, reason: "unknown license (not issued by SKT)" })
    try {
      const { createDefaultTools } = await import("./tools/index.js")
      const closed = createDefaultTools(undefined, undefined, undefined, undefined, {
        licenseKey: "1102-AAAA-BBBB-CCCC",
        licenseServerUrl: stub.url,
        cwd: process.cwd(),
      } as never)
      const pentest = closed.tools.find((t) => t.definition.name === "trayambak__PentestRunTool")
      const result = await pentest!.execute("c1", { toolName: "nmap", target: "example.com" }, undefined)
      expect(result.isError).toBe(true)
      expect(result.content.map((c) => ("text" in c ? c.text : "")).join("")).toContain("not issued")
      expect(stub.seen.verify).toBeGreaterThan(0)
    } finally {
      await stub.close()
    }
  }, 60000)

  it("license refusal surfaces end-to-end through the agent loop", async () => {
    tmpMachineFile()
    const { createDefaultTools } = await import("./tools/index.js")
    const { runAgentLoop } = await import("./agent/agent-loop.js")
    const { Session } = await import("./session/session.js")
    const { tools } = createDefaultTools(undefined, undefined, undefined, undefined, {
      cwd: process.cwd(),
      maxTurns: 2,
      licenseServerUrl: "http://127.0.0.1:1",
      permissions: { mode: "default", rules: [], askByDefault: false },
    } as never)
    const provider = {
      chat: async () => ({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c1",
            name: "trayambak__PentestRunTool",
            arguments: { toolName: "nmap", target: "example.com" },
          },
        ],
        stopReason: "tool_use",
      }),
    } as never
    const messages = await runAgentLoop("scan example.com", {
      provider,
      tools: tools as never,
      session: new Session(),
      config: { cwd: process.cwd(), maxTurns: 2 } as never,
      emit: async () => {},
      onRequestPermission: async () => true,
    })
    const toolMsg = messages.filter((m) => m.role === "tool").pop() as { content: Array<{ text?: string }> } | undefined
    const text = (toolMsg?.content ?? []).map((c) => c.text ?? "").join("\n")
    expect(text).toContain("refused")
  }, 60000)

  it("a server-validated key passes the gate to arg validation", async () => {
    tmpMachineFile()
    const stub = await stubLicenseServer({ valid: true, plan: "pentest" })
    try {
      const { createDefaultTools } = await import("./tools/index.js")
      // NOTE: config is the 5th positional (devMode, onRunAgent, onRunTeam,
      // onAskUserQuestion, config) — 4th slot is onAskUserQuestion.
      const opened = createDefaultTools(undefined, undefined, undefined, undefined, {
        licenseKey: "1102-AAAA-BBBB-CCCC",
        licenseServerUrl: stub.url,
        cwd: process.cwd(),
      } as never)
      const pentest = opened.tools.find((t) => t.definition.name === "trayambak__PentestRunTool")
      expect(pentest).toBeDefined()
      // Empty args: arg validation fires (NOT the license refusal) — proof
      // the gate opened. No scan runs: validation precedes any execution.
      const result = await pentest!.execute("c1", {}, undefined)
      const out = result.content.map((c) => ("text" in c ? c.text : "")).join("")
      expect(out).not.toContain("refused")
      expect(out).toContain("Missing 'toolName'")
      // Validation failure = no execution = no usage report. A real run
      // reports; assert the plumbing with a passing tool instead.
      expect(stub.seen.verify).toBeGreaterThan(0)
    } finally {
      await stub.close()
    }
  }, 60000)
})
