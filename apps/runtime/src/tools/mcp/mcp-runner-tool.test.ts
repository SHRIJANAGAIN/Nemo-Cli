/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * mcp-runner-tool — no real processes. `child_process.spawn` is replaced
 * with a fake child (PassThrough stdio so the real readline framing runs)
 * whose stdin auto-answers every JSON-RPC request id.
 *
 * Pins the fix: MCP servers are third-party code, so the child env goes
 * through getSafeEnv like hook children — secrets are stripped, build
 * essentials (PATH) survive, and operator spec.env still wins.
 */

import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MCP_MAX_BUFFER_BYTES, type McpServerSpec } from "../../../../../packages/mcp/src/index.js"
import { McpProcess } from "./mcp-runner-tool.js"

interface FakeChild extends EventEmitter {
  stdout: PassThrough
  stderr: PassThrough
  stdin: { write: (s: string) => void }
  exitCode: number | null
  killed: boolean
  kill: (signal?: string) => void
}

const ctl = vi.hoisted(() => ({
  spawnArgs: [] as Array<{ cmd: string; args: string[]; opts: { env?: Record<string, string> } }>,
  children: [] as FakeChild[],
  /** When true the fake child never answers, so a test can drive stdout directly. */
  mute: false,
  reset(): void {
    ctl.spawnArgs.length = 0
    ctl.children.length = 0
    ctl.mute = false
  },
}))

/** Auto-answer every JSON-RPC request; notifications (no id) get silence. */
function answerRequest(child: FakeChild, s: string): void {
  if (ctl.mute) return
  let payload: { id?: number; method?: string }
  try {
    payload = JSON.parse(s) as { id?: number; method?: string }
  } catch {
    return
  }
  if (payload.id === undefined) return
  const result = payload.method === "tools/list" ? { tools: [{ name: "t", description: "d" }] } : {}
  child.stdout.push(`${JSON.stringify({ jsonrpc: "2.0", id: payload.id, result })}\n`)
}

vi.mock("child_process", () => ({
  spawn: (cmd: string, args: string[], opts: { env?: Record<string, string> }) => {
    const child = new EventEmitter() as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.exitCode = null
    child.killed = false
    child.stdin = {
      write: (s: string): void => {
        answerRequest(child, s)
      },
    }
    child.kill = (): void => {
      child.killed = true
    }
    ctl.spawnArgs.push({ cmd, args, opts })
    ctl.children.push(child)
    return child
  },
}))

beforeEach(() => {
  ctl.reset()
  vi.stubEnv("MCP_LEAK_PROBE_SECRET", "topsecret")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function spec(extra?: Partial<McpServerSpec>): McpServerSpec {
  return { command: ["fake-mcp"], ...extra }
}

describe("MCP child environment", () => {
  it("strips secrets but keeps PATH and operator spec.env", async () => {
    const proc = new McpProcess("probe", spec({ env: { EXPLICIT_VAR: "yes" } }))
    try {
      await proc.connect()
      const env = ctl.spawnArgs[0]?.opts.env
      expect(env).toBeDefined()
      // The fix: a secret in the parent env must not reach the child.
      expect(env?.["MCP_LEAK_PROBE_SECRET"]).toBeUndefined()
      // Build essentials survive (shells keep working)…
      expect(env?.["PATH"]).toBe(process.env["PATH"])
      // …and explicit operator values still win.
      expect(env?.["EXPLICIT_VAR"]).toBe("yes")
    } finally {
      proc.close()
    }
  })

  it("still completes the JSON-RPC roundtrip through the filtered child", async () => {
    const proc = new McpProcess("probe2", spec())
    try {
      const tools = await proc.listTools()
      expect(tools).toEqual([{ name: "t", description: "d" }])
    } finally {
      proc.close()
    }
  })
})

describe("MCP stdio transport cap (#82a)", () => {
  it("rejects an unframed stdout flood instead of buffering it", async () => {
    ctl.mute = true
    const proc = new McpProcess("flood", spec({ timeoutMs: 3000 }))
    try {
      const connecting = proc.connect()
      // spawnStdio attaches its reader synchronously; one tick lets
      // connect() reach the initialize wait before stdout is flooded.
      await new Promise((r) => setTimeout(r, 10))
      const child = ctl.children[0]
      expect(child).toBeDefined()
      // No newline anywhere: readline used to buffer this unboundedly
      // (OOM class); the capped framer must reject at the boundary.
      child!.stdout.write("x".repeat(MCP_MAX_BUFFER_BYTES + 4096))
      await expect(connecting).rejects.toThrow(/without a frame boundary/)
    } finally {
      proc.close()
    }
  })
})
