/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  SandboxType,
  type SpawnedProcess,
  type SpawnRequest,
  spawnProcess,
  setWindowsAcProbeForTests,
} from "../../../../../packages/sandbox/src/index.js"
import { DEFAULT_PERMISSIONS } from "../../../../../packages/protocol/src/permissions.js"
import type { TrayambakConfig } from "../../config.js"
import type { ToolContext, ToolResult } from "../types.js"
import { createBashTool, osSpawnRequest, resetBackgroundJobsForTests, runForegroundOsSandboxed } from "./bash.js"

/**
 * OS-sandbox engagement (sandboxSpawn flag) without needing seatbelt/bwrap
 * on the test host: the spawner is injected, so these pin the REQUEST the
 * tool builds (command, type, network policy, caps, timeout) and the RESULT
 * contract (output, exit suffix, truthful sandbox marker) on any platform.
 */

const FLAG = "FEATURE_SANDBOXSPAWN"
const savedFlag = process.env[FLAG]

const SHELL = process.platform === "win32" ? "cmd /c" : "sh -c"

const ctxFor = (dir: string): ToolContext =>
  ({
    cwd: dir,
    config: {
      shellCommand: SHELL,
      maxOutputLines: 500,
      maxOutputBytes: 64 * 1024,
    } as unknown as TrayambakConfig,
    permissions: { ...DEFAULT_PERMISSIONS, askByDefault: false },
  }) as ToolContext

function stubProc(overrides: Partial<SpawnedProcess> = {}): SpawnedProcess {
  return {
    pid: 4242,
    isSandboxed: true,
    sandboxType: SandboxType.MacosSeatbelt,
    processGroupId: 4242,
    kill: async () => undefined,
    readAll: async () => "hello-os",
    waitForExit: async () => 0,
    ...overrides,
  }
}

const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text

describe("osSpawnRequest", () => {
  it("builds a spawnProcess request from the tool run", () => {
    const request = osSpawnRequest({
      shell: "sh",
      shellArgs: ["-c"],
      command: "echo hi",
      cwd: "/work",
      env: { PATH: "/bin" },
      sandboxType: SandboxType.LinuxSeccomp,
      networkDisabled: true,
      timeoutMs: 5000,
      signal: undefined,
    })

    expect(request.command).toEqual(["sh", "-c", "echo hi"])
    expect(request.cwd).toBe("/work")
    expect(request.networkPolicy).toMatchObject({ disableNetwork: true })
    expect(request.filesystemPolicy).toMatchObject({ writableRoots: ["/work"] })
    expect(request.outputCap).toBeGreaterThan(0)
    expect(request.timeoutMs).toBe(5000)
  })
})

describe("runForegroundOsSandboxed", () => {
  it("maps output, exit code, and the truthful sandbox marker", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-bashos-"))
    try {
      const seen: unknown[] = []
      const result = await runForegroundOsSandboxed({
        shell: "sh",
        shellArgs: ["-c"],
        command: "echo hi",
        ctx: ctxFor(dir),
        safeEnv: { PATH: "/bin" },
        sandboxType: SandboxType.MacosSeatbelt,
        networkDisabled: false,
        timeoutMs: 5000,
        timeoutSec: 5,
        signal: undefined,
        spawnFn: (async (request: SpawnRequest) => {
          seen.push(request)
          return stubProc()
        }) as never,
      })

      expect(result.isError).toBeFalsy()
      expect(textOf(result)).toContain("hello-os")
      expect(textOf(result)).toContain("[sandbox: os (seatbelt)]")
      const request = seen[0] as {
        command: string[]
        sandboxType: SandboxType
        networkPolicy: { disableNetwork: boolean }
      }
      expect(request.command).toEqual(["sh", "-c", "echo hi"])
      expect(request.sandboxType).toBe(SandboxType.MacosSeatbelt)
      expect(request.networkPolicy.disableNetwork).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("marks failing runs failed with exit suffix and marker", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-bashos-"))
    try {
      const result = await runForegroundOsSandboxed({
        shell: "sh",
        shellArgs: ["-c"],
        command: "exit 3",
        ctx: ctxFor(dir),
        safeEnv: {},
        sandboxType: SandboxType.LinuxSeccomp,
        networkDisabled: true,
        timeoutMs: 5000,
        timeoutSec: 5,
        signal: undefined,
        spawnFn: (async () => stubProc({ sandboxType: SandboxType.LinuxSeccomp, waitForExit: async () => 3 })) as never,
      })

      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain("[exit code 3]")
      expect(textOf(result)).toContain("[sandbox: os (seccomp)]")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports spawn failures and timeouts with the tool's own messages", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-bashos-"))
    try {
      const failed = await runForegroundOsSandboxed({
        shell: "sh",
        shellArgs: ["-c"],
        command: "x",
        ctx: ctxFor(dir),
        safeEnv: {},
        sandboxType: SandboxType.MacosSeatbelt,
        networkDisabled: false,
        timeoutMs: 5000,
        timeoutSec: 5,
        signal: undefined,
        spawnFn: (async () => Promise.reject(new Error("no bwrap"))) as never,
      })
      expect(failed.isError).toBe(true)
      expect(textOf(failed)).toContain("Command failed: no bwrap")

      const hanging = await runForegroundOsSandboxed({
        shell: "sh",
        shellArgs: ["-c"],
        command: "x",
        ctx: ctxFor(dir),
        safeEnv: {},
        sandboxType: SandboxType.MacosSeatbelt,
        networkDisabled: false,
        timeoutMs: 60,
        timeoutSec: 5,
        signal: undefined,
        spawnFn: (() => new Promise<never>(() => undefined)) as never,
      })
      expect(textOf(hanging)).toContain("Command timed out after 5s")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("aborts through the handle kill and says so", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-bashos-"))
    try {
      const controller = new AbortController()
      const kills: string[] = []
      const pending = runForegroundOsSandboxed({
        shell: "sh",
        shellArgs: ["-c"],
        command: "x",
        ctx: ctxFor(dir),
        safeEnv: {},
        sandboxType: SandboxType.MacosSeatbelt,
        networkDisabled: false,
        timeoutMs: 5000,
        timeoutSec: 5,
        signal: controller.signal,
        spawnFn: (async () => stubProc({ kill: async (signal?: string) => void kills.push(signal ?? "") })) as never,
      })
      controller.abort()
      const result = await pending

      expect(textOf(result)).toBe("Command aborted")
      expect(kills).toEqual(["SIGKILL"])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("bash OS path engagement", () => {
  afterEach(() => {
    if (savedFlag === undefined) delete process.env[FLAG]
    else process.env[FLAG] = savedFlag
    resetBackgroundJobsForTests()
  })

  it("stays on the policy path (no marker) where no isolator exists, flag or not", async () => {
    process.env[FLAG] = "1"
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-bashos-"))
    try {
      const spawnFn = vi.fn(async () => stubProc())
      const tool = createBashTool({ spawnFn: spawnFn as never })
      const result = await tool.execute("t1", { command: "echo policy-path" }, undefined, undefined, ctxFor(dir))

      // Detection stays honest on this host: the helper probe answers false
      // under NODE_ENV=test (and non-win32 hosts have no seatbelt/bwrap
      // here), so sandboxType is None and the gate holds the policy path:
      // the injected spawner must never fire and the marker must never
      // print — byte-identical behavior with the flag on.
      expect(textOf(result)).toContain("policy-path")
      expect(textOf(result)).not.toContain("[sandbox: os")
      expect(spawnFn).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("engages the OS path when detection reports the AppContainer isolator", async () => {
    process.env[FLAG] = "1"
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-bashos-"))
    const original = Object.getOwnPropertyDescriptor(process, "platform")
    setWindowsAcProbeForTests(() => true)
    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
    try {
      const spawnFn = vi.fn(async (_request: SpawnRequest) =>
        stubProc({ sandboxType: SandboxType.WindowsRestrictedToken }),
      )
      const tool = createBashTool({ spawnFn: spawnFn as never })
      const result = await tool.execute("t1", { command: "echo os-path" }, undefined, undefined, ctxFor(dir))

      expect(spawnFn).toHaveBeenCalledTimes(1)
      const request = spawnFn.mock.calls[0]?.[0]
      expect(request?.sandboxType).toBe(SandboxType.WindowsRestrictedToken)
      expect(textOf(result)).toContain("hello-os")
      expect(textOf(result)).toContain("[sandbox: os (windows_sandbox)]")
    } finally {
      if (original) Object.defineProperty(process, "platform", original)
      setWindowsAcProbeForTests(null)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("background OS jobs capture output end-to-end (readAll attached before waitForExit)", async () => {
    process.env[FLAG] = "1"
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-bashos-"))
    const original = Object.getOwnPropertyDescriptor(process, "platform")
    setWindowsAcProbeForTests(() => true)
    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
    try {
      // The REAL spawner on a real child: a stub's readAll resolves
      // whenever it is called, so only a live process can prove the job
      // registry attaches readAll before waiting (a late attach silently
      // loses streamed bytes). Type is swapped to None so the test pins
      // sequencing only — the AppContainer shim itself is covered by the
      // win32 integration case in packages/sandbox/src/spawn.test.ts.
      const spawnFn = async (req: SpawnRequest) => spawnProcess({ ...req, sandboxType: SandboxType.None })
      const tool = createBashTool({ spawnFn: spawnFn as never })
      const start = await tool.execute(
        "t1",
        { command: "echo bg-os-output", background: true },
        undefined,
        undefined,
        ctxFor(dir),
      )
      const startText = textOf(start)
      expect(startText).toContain("Background job started.")
      const id = /job_id: ([0-9a-f-]+)/.exec(startText)?.[1] as string

      let finalText = ""
      for (let i = 0; i < 150; i++) {
        const poll = await tool.execute("t1", { job_id: id }, undefined, undefined, ctxFor(dir))
        finalText = textOf(poll)
        if (finalText.includes("finished")) break
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(finalText).toContain("finished")
      expect(finalText).toContain("bg-os-output")
    } finally {
      if (original) Object.defineProperty(process, "platform", original)
      setWindowsAcProbeForTests(null)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
