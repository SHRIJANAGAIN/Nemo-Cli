/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_PERMISSIONS } from "../../../../../packages/protocol/src/permissions.js"
import type { TrayambakConfig } from "../../config.js"
import type { ToolContext } from "../types.js"
import {
  createTerminalSession,
  createTerminalTool,
  killTerminal,
  listTerminals,
  readTerminalOutput,
  resetTerminalsForTests,
  sendTerminalInput,
  TERMINAL_MAX_SESSIONS,
} from "./terminal.js"

/**
 * Interactive shells with real stdin round-trips (no mocks for the core
 * loop: a shell that cannot echo is not a shell). Temp dirs only.
 */

const SHELL = process.platform === "win32" ? "cmd" : "sh"

const ctxFor = (dir: string): ToolContext =>
  ({
    cwd: dir,
    config: { shellCommand: process.platform === "win32" ? "cmd /c" : "sh -c" } as unknown as TrayambakConfig,
    permissions: { ...DEFAULT_PERMISSIONS, askByDefault: false },
  }) as ToolContext

let dir = ""

afterEach(async () => {
  resetTerminalsForTests()
  // Windows locks a process's CWD: give the kills above a beat to land
  // before removing the temp dir they were started in.
  await new Promise((r) => setTimeout(r, 800))
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* shells already dead; best-effort cleanup */
    }
  }
  dir = ""
})

function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), "trayambak-terminal-"))
  return dir
}

async function waitFor(id: string, needle: string, fromBytes = 0): Promise<string> {
  const start = Date.now()
  for (;;) {
    const { output } = readTerminalOutput(id, fromBytes)
    if (output.includes(needle)) return output
    if (Date.now() - start > 10_000) throw new Error(`timed out waiting for '${needle}'`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe("interactive round-trip", () => {
  it("echoes sent input back through a live shell", async () => {
    const cwd = tempDir()
    const session = createTerminalSession(SHELL, cwd, { PATH: process.env.PATH ?? "" })
    expect(session.live).toBe(true)

    sendTerminalInput(session.id, "echo TERM-PROBE-123")
    const output = await waitFor(session.id, "TERM-PROBE-123")

    expect(output).toContain("TERM-PROBE-123")
  }, 15000)

  it("replays from a byte cursor without duplicating", async () => {
    tempDir()
    const session = createTerminalSession(SHELL, dir, { PATH: process.env.PATH ?? "" })
    sendTerminalInput(session.id, "echo CURSOR-A")
    await waitFor(session.id, "CURSOR-A")
    const at = readTerminalOutput(session.id, 0).offset

    sendTerminalInput(session.id, "echo CURSOR-B")
    await waitFor(session.id, "CURSOR-B", at)

    // Replay is idempotent: two reads from the same cursor return the same
    // bytes, and both contain everything appended after the cursor.
    const first = readTerminalOutput(session.id, at)
    const second = readTerminalOutput(session.id, at)
    expect(first.output).toContain("CURSOR-B")
    expect(second.output).toBe(first.output)
    expect(first.offset).toBeGreaterThanOrEqual(at)
  }, 15000)

  it("reports exit on kill and refuses input afterwards", async () => {
    tempDir()
    const session = createTerminalSession(SHELL, dir, { PATH: process.env.PATH ?? "" })

    expect(killTerminal(session.id).exited).toBe(false)
    await new Promise((r) => setTimeout(r, 500))
    expect(() => sendTerminalInput(session.id, "echo hi")).toThrow("exited")
    expect(killTerminal(session.id).exited).toBe(true)
  }, 15000)
})

describe("terminal registry", () => {
  it("lists live sessions and caps the count", () => {
    tempDir()
    expect(listTerminals()).toEqual([])

    for (let i = 0; i < TERMINAL_MAX_SESSIONS; i++) {
      createTerminalSession(SHELL, dir, {})
    }
    expect(listTerminals()).toHaveLength(TERMINAL_MAX_SESSIONS)
    expect(() => createTerminalSession(SHELL, dir, {})).toThrow("Too many live terminals")
  })

  it("rejects unknown ids everywhere", () => {
    expect(() => sendTerminalInput("nope", "hi")).toThrow("Unknown terminal")
    expect(() => readTerminalOutput("nope")).toThrow("Unknown terminal")
    expect(() => killTerminal("nope")).toThrow("Unknown terminal")
  })

  it("rejects oversized input", () => {
    tempDir()
    const session = createTerminalSession(SHELL, dir, {})

    expect(() => sendTerminalInput(session.id, "x".repeat(9 * 1024))).toThrow("exceeds")
  })

  it("prunes dead sessions so the registry stays bounded", async () => {
    tempDir()
    for (let i = 0; i < 25; i++) {
      const session = createTerminalSession(SHELL, dir, {})
      killTerminal(session.id)
      // A kill lands asynchronously — wait for death before the next
      // create, or the live cap (not the prune path) answers first.
      const start = Date.now()
      for (;;) {
        const current = listTerminals().find((s) => s.id === session.id)
        if (!current || !current.live) break
        if (Date.now() - start > 10_000) throw new Error("session never died")
        await new Promise((r) => setTimeout(r, 50))
      }
    }

    expect(listTerminals().length).toBeLessThanOrEqual(20)
  }, 60000)
})

describe("createTerminalTool", () => {
  it("exposes the terminal identity and validates actions", async () => {
    const tool = createTerminalTool()
    expect(tool.definition.name).toBe("terminal")

    const ctx = ctxFor(tempDir())
    const missing = await tool.execute("t1", {}, undefined, undefined, ctx)
    expect(missing.isError).toBe(true)

    const created = await tool.execute("t1", { action: "create" }, undefined, undefined, ctx)
    expect(created.isError).toBeFalsy()
    const id = /id: ([0-9a-f-]+)/.exec(created.content.map((c) => c.text).join())?.[1]
    expect(id).toBeTruthy()

    const sent = await tool.execute("t1", { action: "send", id, input: "echo TOOL-PROBE" }, undefined, undefined, ctx)
    expect(sent.isError).toBeFalsy()

    const listed = await tool.execute("t1", { action: "list" }, undefined, undefined, ctx)
    expect(listed.content.map((c) => c.text).join()).toContain(id!)

    const read = await tool.execute("t1", { action: "read", id }, undefined, undefined, ctx)
    expect(read.isError).toBe(false)

    const killed = await tool.execute("t1", { action: "kill", id }, undefined, undefined, ctx)
    expect(killed.isError).toBe(false)
  }, 15000)
})
