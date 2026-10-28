/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { PassThrough } from "node:stream"
import { dispatchMcpServer, runMcpServer, clampMcpTimeout, type McpServerDeps } from "./index.js"
import type { NemoConfig } from "../../../apps/runtime/src/config.js"
import type { HookShellExecutor } from "../../../apps/runtime/src/tools/hook-exec.js"
import { ExecDecision } from "../../../packages/execpolicy/src/policy.js"

/**
 * MCP server gate tests (#32-35): every executing tool passes PreToolUse
 * hooks → approvalFor → execpolicy → roots, mirroring the agent loop (all
 * four were raw syscalls before). Deterministic: config is always injected
 * (never the machine's), hook executors are stubbed, policy decisions are
 * injected except where the real default is the assertion, and the only
 * real processes spawned are `echo`-class trivialities plus one 3s
 * sleeper proving the timeout kills.
 */

const writes: string[] = []

function listen(): void {
  writes.length = 0
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write)
}

afterEach(() => {
  vi.restoreAllMocks()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  }
})

const dirs: string[] = []

function freshDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

interface McpResult {
  content?: Array<{ type?: string; text?: string }>
  isError?: boolean
}

function replyFor(id: unknown): { result?: McpResult; error?: { code?: number; message?: string } } {
  for (const chunk of writes.join("").split("\n")) {
    const line = chunk.trim()
    if (!line.startsWith("{")) continue
    try {
      const parsed = JSON.parse(line) as {
        id?: unknown
        result?: McpResult
        error?: { code?: number; message?: string }
      }
      if (parsed.id === id) return parsed
    } catch {
      /* non-JSON stdout */
    }
  }
  throw new Error(`no MCP response for id ${String(id)}`)
}

function textOf(id: unknown): { text: string; isError: boolean } {
  const res = replyFor(id)
  return {
    text: (res.result?.content ?? []).map((c) => c.text ?? "").join("\n"),
    isError: res.result?.isError === true,
  }
}

function testConfig(cwd: string, extra?: Record<string, unknown>): NemoConfig {
  return { cwd, ...(extra ?? {}) } as unknown as NemoConfig
}

function denyExecutor(reason: string): HookShellExecutor {
  return {
    run: async () => ({
      exitCode: 0,
      stdout: {
        text: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        }),
      },
      stderr: { text: "" },
    }),
  }
}

const neverPolicy = (): never => {
  throw new Error("must not reach execpolicy after an earlier refusal")
}

describe("mcp-server dispatch", () => {
  it("handles tools/list without throwing", async () => {
    await expect(dispatchMcpServer({ method: "tools/list" })).resolves.toBeUndefined()
  })

  it("advertises timeoutMs on the bash schema (#34 schema half)", async () => {
    listen()
    await dispatchMcpServer({ id: "schema", method: "tools/list" }, { config: testConfig(os.tmpdir()) })
    const parsed = replyFor("schema")
    const tools = (parsed.result as { tools?: Array<{ name?: string; inputSchema?: unknown }> })?.tools ?? []
    const bash = tools.find((t) => t.name === "bash")
    const props = (bash?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}
    expect(props).toHaveProperty("timeoutMs")
  })

  it("marks non-executed tools as refused in their descriptions (no silent no-op)", async () => {
    listen()
    await dispatchMcpServer({ id: "schema2", method: "tools/list" }, { config: testConfig(os.tmpdir()) })
    const parsed = replyFor("schema2")
    const tools = (parsed.result as { tools?: Array<{ name?: string; description?: string }> })?.tools ?? []
    for (const name of ["write_file", "grep", "glob"]) {
      const tool = tools.find((t) => t.name === name)
      expect(tool?.description).toMatch(/not executed via MCP/i)
    }
    expect(tools.find((t) => t.name === "bash")?.description).not.toMatch(/not executed/i)
  })
})

describe("clampMcpTimeout", () => {
  it("bounds finite input and falls back otherwise", () => {
    expect(clampMcpTimeout(undefined)).toBe(10_000)
    expect(clampMcpTimeout(Number.NaN)).toBe(10_000)
    expect(clampMcpTimeout(500)).toBe(1000)
    expect(clampMcpTimeout(-5)).toBe(1000)
    expect(clampMcpTimeout(5000)).toBe(5000)
    expect(clampMcpTimeout(999_999_999)).toBe(300_000)
  })
})

describe("bash gate (#32): deny rules are enforced without spawning", () => {
  it("refuses a legacy deny-listed command (audit repro shape)", async () => {
    listen()
    const cwd = freshDir("nemo-mcp-deny-")
    const cfg = testConfig(cwd, {
      permissions: { uiMode: "ask", rules: [{ tool: "bash", pattern: "rm -rf /", allow: false }] },
    })
    const deps: McpServerDeps = {
      config: cfg,
      policyDecide: neverPolicy,
    }
    await dispatchMcpServer(
      { id: "d1", method: "tools/call", params: { name: "bash", arguments: { command: "rm -rf /" } } },
      deps,
    )
    const { text, isError } = textOf("d1")
    expect(isError).toBe(true)
    expect(text).toContain("denied")
  })
})

describe("bash gate: ask without an approver refuses", () => {
  it("refuses before execpolicy for an ask-gated command", async () => {
    listen()
    const cwd = freshDir("nemo-mcp-ask-")
    const cfg = testConfig(cwd, { permissions: { uiMode: "ask" } })
    const deps: McpServerDeps = {
      config: cfg,
      policyDecide: neverPolicy,
    }
    await dispatchMcpServer(
      { id: "a1", method: "tools/call", params: { name: "bash", arguments: { command: "echo hi" } } },
      deps,
    )
    const { text, isError } = textOf("a1")
    expect(isError).toBe(true)
    expect(text).toContain("requires approval")
  })
})

describe("bash gate: execpolicy layer", () => {
  const allowCfg = (cwd: string): NemoConfig =>
    testConfig(cwd, {
      permissions: { uiMode: "ask", rulesV2: [{ tool: "bash", pattern: "*", action: "allow" }] },
    })

  it("refuses on execpolicy Deny after an approval allow", async () => {
    listen()
    const cwd = freshDir("nemo-mcp-pol-")
    const deps: McpServerDeps = {
      config: allowCfg(cwd),
      policyDecide: () => ExecDecision.Deny,
    }
    await dispatchMcpServer(
      // Vehicle must clear the approval layer: a blanket `bash(*)` allow no
      // longer unlocks force-ask commands like `sudo` (#90), and this test is
      // about the execpolicy layer running *after* an approval allow.
      { id: "p1", method: "tools/call", params: { name: "bash", arguments: { command: "echo hi" } } },
      deps,
    )
    const { text, isError } = textOf("p1")
    expect(isError).toBe(true)
    expect(text).toContain("exec policy")
  })

  it("refuses on execpolicy Ask (no interactive approver over MCP)", async () => {
    listen()
    const cwd = freshDir("nemo-mcp-polask-")
    const deps: McpServerDeps = {
      config: allowCfg(cwd),
      policyDecide: () => ExecDecision.Ask,
    }
    await dispatchMcpServer(
      { id: "p2", method: "tools/call", params: { name: "bash", arguments: { command: "echo hi" } } },
      deps,
    )
    const { text, isError } = textOf("p2")
    expect(isError).toBe(true)
    expect(text).toContain("exec policy requires approval")
  })

  it("enforces the timeout it advertises", async () => {
    listen()
    const cwd = freshDir("nemo-mcp-timeout-")
    const sleep = process.platform === "win32" ? "timeout /t 3 /nobreak" : "sleep 3"
    const deps: McpServerDeps = {
      config: allowCfg(cwd),
      policyDecide: () => ExecDecision.Allow,
    }
    await dispatchMcpServer(
      { id: "p3", method: "tools/call", params: { name: "bash", arguments: { command: sleep, timeoutMs: 1200 } } },
      deps,
    )
    const { text, isError } = textOf("p3")
    expect(isError).toBe(true)
    expect(text).toMatch(/timeout|ETIMEDOUT|kill|SIGTERM/i)
  }, 15000)
})

describe("bash gate: PreToolUse hooks run first", () => {
  it("a hook deny blocks before approval and execpolicy", async () => {
    listen()
    const cwd = freshDir("nemo-mcp-hook-")
    const cfg = testConfig(cwd, {
      permissions: { uiMode: "ask", rulesV2: [{ tool: "bash", pattern: "*", action: "allow" }] },
      hooks: { preToolUse: [{ hooks: [{ command: "gate.sh" }] }] },
    })
    const deps: McpServerDeps = {
      config: cfg,
      hookExecutor: denyExecutor("nope"),
      policyDecide: neverPolicy,
    }
    await dispatchMcpServer(
      { id: "h1", method: "tools/call", params: { name: "bash", arguments: { command: "echo hi" } } },
      deps,
    )
    const { text, isError } = textOf("h1")
    expect(isError).toBe(true)
    expect(text).toContain("Hook blocked")
    expect(text).toContain("nope")
  })
})

describe("bash child env is filtered (#63)", () => {
  it("strips secret-bearing vars from the spawned child but keeps ordinary env", async () => {
    listen()
    const cwd = freshDir("nemo-mcp-env-")
    process.env.NEMO_MCP_ENV_KEEP = "visible-thing"
    process.env.NEMO_MCP_ENV_SECRET = "leaked-credential"
    try {
      const deps: McpServerDeps = {
        config: testConfig(cwd, {
          permissions: { uiMode: "ask", rulesV2: [{ tool: "bash", pattern: "*", action: "allow" }] },
        }),
        policyDecide: () => ExecDecision.Allow,
      }
      const probe =
        process.platform === "win32"
          ? "echo %NEMO_MCP_ENV_KEEP% %NEMO_MCP_ENV_SECRET%"
          : "echo $NEMO_MCP_ENV_KEEP $NEMO_MCP_ENV_SECRET"
      await dispatchMcpServer(
        { id: "e1", method: "tools/call", params: { name: "bash", arguments: { command: probe } } },
        deps,
      )
      const { text, isError } = textOf("e1")
      expect(isError).toBe(false)
      // Ordinary env survives (shells still need PATH, HOME, …)…
      expect(text).toContain("visible-thing")
      // …the SECRET-family var never reaches the child (was: full process
      // env inherited verbatim — API keys included).
      expect(text).not.toContain("leaked-credential")
    } finally {
      delete process.env.NEMO_MCP_ENV_KEEP
      delete process.env.NEMO_MCP_ENV_SECRET
    }
  }, 15000)
})

describe("read_file gate (#35): approval + roots", () => {
  const readCfg = (cwd: string): NemoConfig =>
    testConfig(cwd, {
      permissions: { uiMode: "ask", rulesV2: [{ tool: "read_file", pattern: "*", action: "allow" }] },
    })

  it("reads inside the root", async () => {
    listen()
    const cwd = freshDir("nemo-mcp-read-")
    fs.writeFileSync(path.join(cwd, "notes.txt"), "hello-root")
    await dispatchMcpServer(
      { id: "r1", method: "tools/call", params: { name: "read_file", arguments: { path: "notes.txt" } } },
      { config: readCfg(cwd) },
    )
    const { text, isError } = textOf("r1")
    expect(isError).toBe(false)
    expect(text).toContain("hello-root")
  })

  it("refuses outside the root without reading", async () => {
    listen()
    const cwd = freshDir("nemo-mcp-readout-")
    const outside = freshDir("nemo-mcp-outside-")
    fs.writeFileSync(path.join(outside, "secret.txt"), "shh")
    await dispatchMcpServer(
      {
        id: "r2",
        method: "tools/call",
        params: { name: "read_file", arguments: { path: path.join(outside, "secret.txt") } },
      },
      { config: readCfg(cwd) },
    )
    const { text, isError } = textOf("r2")
    expect(isError).toBe(true)
    expect(text).toContain("outside the allowed root")
  })

  it("denies by approval rule before reaching the filesystem", async () => {
    listen()
    const cwd = freshDir("nemo-mcp-readdeny-")
    fs.writeFileSync(path.join(cwd, "secret.txt"), "shh")
    const cfg = testConfig(cwd, {
      permissions: { uiMode: "ask", rulesV2: [{ tool: "read_file", pattern: "secret", action: "deny" }] },
    })
    await dispatchMcpServer(
      { id: "r3", method: "tools/call", params: { name: "read_file", arguments: { path: "secret.txt" } } },
      { config: cfg },
    )
    const { text, isError } = textOf("r3")
    expect(isError).toBe(true)
    expect(text).toContain("denied")
  })
})

describe("refused tools stay refused", () => {
  it("write_file is never executed by mcp-server", async () => {
    listen()
    const cwd = freshDir("nemo-mcp-write-")
    // Allowlisted at approval so the refusal comes from the tool contract
    // itself (not the gate): the shape of the refusal is what's pinned.
    const cfg = testConfig(cwd, {
      permissions: { uiMode: "ask", rulesV2: [{ tool: "write_file", pattern: "*", action: "allow" }] },
    })
    await dispatchMcpServer(
      {
        id: "w1",
        method: "tools/call",
        params: { name: "write_file", arguments: { path: path.join(cwd, "x.txt"), content: "x" } },
      },
      { config: cfg },
    )
    const { text, isError } = textOf("w1")
    expect(isError).toBe(true)
    expect(text).toContain("not executed by mcp-server")
    expect(fs.existsSync(path.join(cwd, "x.txt"))).toBe(false)
  })
})

describe("serverInfo version and stdio liveness", () => {
  it("advertises the single-sourced root package version", async () => {
    listen()
    await dispatchMcpServer({ id: "init", method: "initialize" })

    // Drift guard: a hardcoded literal went stale at 0.6.0 while the
    // release shipped 0.6.7 — the advertised version must track the root
    // package.json (via apps/cli/src/version.ts, stamped by sync-version).
    const rootPkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "package.json"), "utf8")) as {
      version: string
    }
    const parsed = replyFor("init") as unknown as {
      result?: { serverInfo?: { name?: string; version?: string } }
    }
    expect(parsed.result?.serverInfo).toEqual({ name: "nemo", version: rootPkg.version })
  })

  it("pins the event loop until stdin closes, then releases it", async () => {
    const savedStdin = Object.getOwnPropertyDescriptor(process, "stdin")
    const fakeStdin = new PassThrough()
    const intervalSpy = vi.spyOn(global, "setInterval")
    const clearIntervalSpy = vi.spyOn(global, "clearInterval")
    try {
      Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true, writable: true })
      runMcpServer()

      const entry = intervalSpy.mock.results
        .map((result, i) => ({ call: intervalSpy.mock.calls[i], handle: result.value }))
        .find(({ call }) => call?.[1] === 1 << 30)
      expect(entry).toBeDefined()
      // A ref'd timer handle keeps Node's loop alive while the client
      // still holds the pipe open — an idle loop that drains used to let
      // the server exit mid-session (dead-pid cleanup on the client).
      const handle = entry?.handle as unknown as { hasRef?: () => boolean }
      expect(typeof handle?.hasRef).toBe("function")
      expect(handle.hasRef?.()).toBe(true)

      fakeStdin.destroy()
      for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve))
      // stdin EOF releases the pin — the loop may drain and exit now.
      expect(clearIntervalSpy).toHaveBeenCalledWith(entry?.handle)
    } finally {
      if (savedStdin) Object.defineProperty(process, "stdin", savedStdin)
      fakeStdin.destroy()
      intervalSpy.mockRestore()
      clearIntervalSpy.mockRestore()
    }
  })
})
