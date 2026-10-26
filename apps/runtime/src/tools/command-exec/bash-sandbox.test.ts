/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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
import { landlockArgs } from "../../../../../packages/sandbox/src/spawn.js"
import { canWrite } from "../../../../../packages/sandbox/src/fs-policy.js"
import type { NemoConfig } from "../../config.js"
import type { ToolContext, ToolResult } from "../types.js"
import {
  createBashTool,
  isReadOnlyMode,
  osSpawnRequest,
  resetBackgroundJobsForTests,
  resetShellProbeForTests,
  runForegroundOsSandboxed,
  seedShellProbeForTests,
} from "./bash.js"

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
    } as unknown as NemoConfig,
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

  /**
   * The mode now selects the FILESYSTEM policy, not the isolator. plan /
   * read-only emit an EMPTY `writableRoots`, which `fs-policy.ts` defines as
   * deny-all - the only reading under which "read-only" means anything at the
   * OS layer. Before this, both modes reported `SandboxType.None`, so the OS
   * layer was never consulted and the restriction existed only in the
   * in-process screen.
   */
  it("readOnly emits an empty writableRoots - deny-all, not allow-all", () => {
    const request = osSpawnRequest({
      shell: "sh",
      shellArgs: ["-c"],
      command: "echo hi",
      cwd: "/work",
      env: { PATH: "/bin" },
      sandboxType: SandboxType.WindowsRestrictedToken,
      networkDisabled: false,
      timeoutMs: 5000,
      readOnly: true,
      signal: undefined,
    })

    expect(request.filesystemPolicy?.writableRoots).toEqual([])
    // Extra roots must not resurrect a grant the mode withheld.
    const withExtras = osSpawnRequest({
      shell: "sh",
      shellArgs: ["-c"],
      command: "echo hi",
      cwd: "/work",
      env: { PATH: "/bin" },
      sandboxType: SandboxType.WindowsRestrictedToken,
      networkDisabled: false,
      timeoutMs: 5000,
      extraWritableRoots: ["/other"],
      readOnly: true,
      signal: undefined,
    })
    expect(withExtras.filesystemPolicy?.writableRoots).toEqual([])
  })

  /** The default must stay permissive: only an explicit readOnly opts in. */
  it("omitting readOnly keeps cwd writable (unchanged default)", () => {
    const request = osSpawnRequest({
      shell: "sh",
      shellArgs: ["-c"],
      command: "echo hi",
      cwd: "/work",
      env: { PATH: "/bin" },
      sandboxType: SandboxType.LinuxSeccomp,
      networkDisabled: false,
      timeoutMs: 5000,
      signal: undefined,
    })

    expect(request.filesystemPolicy?.writableRoots).toEqual(["/work"])
  })

  /** isReadOnlyMode drives the flag above; it must not over-reach. */
  it("isReadOnlyMode is true only for plan and read-only uiModes", () => {
    expect(isReadOnlyMode({ uiMode: "plan" })).toBe(true)
    expect(isReadOnlyMode({ uiMode: "read-only" })).toBe(true)
    expect(isReadOnlyMode({ uiMode: "ask" })).toBe(false)
    expect(isReadOnlyMode({ uiMode: "auto-approve" })).toBe(false)
    // full-access means "stop asking", not "allow writes": the workspace must
    // NOT silently get its write grant back under a mode named full-access.
    expect(isReadOnlyMode({ uiMode: "full-access" })).toBe(false)
    expect(isReadOnlyMode({ mode: "yolo" })).toBe(false)
    expect(isReadOnlyMode({})).toBe(false)
  })

  /**
   * The policy has to survive the trip from the tool to the OS layer, or the
   * sandbox is decorative. `osSpawnRequest` used to hardcode
   * `readOnlySubpaths: []`, which was harmless only while the backends ignored
   * the field; now that `fs-policy.ts` applies it, a declared carve-out that is
   * dropped here becomes a writable path the policy promised to protect.
   */
  it("threads a read-only carve-out through to the spawn request", () => {
    const request = osSpawnRequest({
      shell: "sh",
      shellArgs: ["-c"],
      command: "rm -rf .git",
      cwd: "/work",
      env: { PATH: "/bin" },
      sandboxType: SandboxType.LinuxSeccomp,
      networkDisabled: false,
      timeoutMs: 5000,
      readOnlySubpaths: [".git"],
    })
    expect(request.filesystemPolicy.readOnlySubpaths).toEqual([path.resolve("/work", ".git")])
  })

  it("resolves a RELATIVE carve-out, because the OS layer compares absolute paths", () => {
    // Left relative, `.git` would never match the absolute path a bubblewrap
    // mount or an SBPL subpath refers to, and the carve-out would silently do
    // nothing — the exact failure mode it exists to prevent.
    const request = osSpawnRequest({
      shell: "sh",
      shellArgs: ["-c"],
      command: "rm -rf .git",
      cwd: "/work",
      env: { PATH: "/bin" },
      sandboxType: SandboxType.MacosSeatbelt,
      networkDisabled: false,
      timeoutMs: 5000,
      readOnlySubpaths: [".git", "node_modules"],
    })
    for (const p of request.filesystemPolicy.readOnlySubpaths) {
      expect(path.isAbsolute(p), p).toBe(true)
    }
  })

  it("leaves an absolute carve-out untouched", () => {
    const abs = path.resolve("/elsewhere", "locked")
    const request = osSpawnRequest({
      shell: "sh",
      shellArgs: ["-c"],
      command: "echo hi",
      cwd: "/work",
      env: { PATH: "/bin" },
      sandboxType: SandboxType.LinuxSeccomp,
      networkDisabled: false,
      timeoutMs: 5000,
      readOnlySubpaths: [abs],
    })
    expect(request.filesystemPolicy.readOnlySubpaths).toEqual([abs])
  })

  it("keeps cwd writable even when a carve-out covers all of it", () => {
    // Carving out the workspace entirely must not remove it from writableRoots:
    // the mount still has to exist for `--chdir` to succeed. The read-only-ness
    // is expressed by the carve-out, not by dropping the root.
    const request = osSpawnRequest({
      shell: "sh",
      shellArgs: ["-c"],
      command: "echo hi",
      cwd: "/work",
      env: { PATH: "/bin" },
      sandboxType: SandboxType.LinuxSeccomp,
      networkDisabled: false,
      timeoutMs: 5000,
      readOnlySubpaths: ["/work"],
    })
    expect(request.filesystemPolicy.writableRoots).toContain("/work")
    expect(request.filesystemPolicy.readOnlySubpaths).toContain("/work")
  })

  it("adds extra writable roots and de-duplicates cwd", () => {
    // A duplicate root is a redundant bubblewrap mount, not a harmless repeat.
    const request = osSpawnRequest({
      shell: "sh",
      shellArgs: ["-c"],
      command: "echo hi",
      cwd: "/work",
      env: { PATH: "/bin" },
      sandboxType: SandboxType.LinuxSeccomp,
      networkDisabled: false,
      timeoutMs: 5000,
      extraWritableRoots: ["/work", "/shared", "sub"],
    })
    expect(request.filesystemPolicy.writableRoots).toEqual(["/work", "/shared", path.resolve("/work", "sub")])
    expect(new Set(request.filesystemPolicy.writableRoots).size).toBe(
      request.filesystemPolicy.writableRoots.length,
    )
  })

  it("defaults to cwd-only with no carve-outs when the caller says nothing", () => {
    const request = osSpawnRequest({
      shell: "sh",
      shellArgs: ["-c"],
      command: "echo hi",
      cwd: "/work",
      env: { PATH: "/bin" },
      sandboxType: SandboxType.LinuxSeccomp,
      networkDisabled: false,
      timeoutMs: 5000,
    })
    expect(request.filesystemPolicy.writableRoots).toEqual(["/work"])
    expect(request.filesystemPolicy.readOnlySubpaths).toEqual([])
  })
})

describe("the tool and the OS layer agree about a carve-out", () => {
  /**
   * The end-to-end property: whatever `osSpawnRequest` produces, the real
   * argument builders must honour. If these disagree the policy screen says one
   * thing and the kernel enforces another — which is the failure the
   * `filesystemPolicy` bug was, in a different costume.
   */
  // Deliberately NOT `as const`: that makes `shellArgs` a readonly tuple, which
  // is not assignable to the `string[]` the builder declares. A spread of a
  // readonly array into a mutable signature is a compile error, and a test that
  // needs a cast to call the code under test is testing something else.
  const base = {
    shell: "sh",
    shellArgs: ["-c"] as string[],
    command: "rm -rf .git",
    cwd: path.resolve("/work"),
    env: { PATH: "/bin" } as Record<string, string>,
    networkDisabled: false,
    timeoutMs: 5000,
  }

  it("a declared carve-out produces NO writable bind for that path", () => {
    const request = osSpawnRequest({
      ...base,
      sandboxType: SandboxType.LinuxSeccomp,
      readOnlySubpaths: ["src"],
    })
    const carved = path.resolve(base.cwd, "src")
    const args = landlockArgs(
      request.command,
      request.cwd,
      request.networkPolicy,
      request.filesystemPolicy,
    )
    // The carve-out is nested inside cwd, so cwd stays mounted; what must NOT
    // appear is a separate writable bind for the carved path.
    expect(args.filter((a) => a === "--bind" && args[args.indexOf(a) + 2] === carved)).toHaveLength(0)
    expect(canWrite(request.filesystemPolicy, carved)).toBe(false)
  })

  it("an undeclared path inside cwd IS writable", () => {
    const request = osSpawnRequest({ ...base, sandboxType: SandboxType.LinuxSeccomp })
    expect(canWrite(request.filesystemPolicy, path.resolve(base.cwd, "src", "a.ts"))).toBe(true)
  })

  it("a path outside cwd is never writable", () => {
    const request = osSpawnRequest({ ...base, sandboxType: SandboxType.LinuxSeccomp })
    expect(canWrite(request.filesystemPolicy, "/etc/passwd")).toBe(false)
  })
})

describe("runForegroundOsSandboxed", () => {
  it("maps output, exit code, and the truthful sandbox marker", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-bashos-"))
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-bashos-"))
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-bashos-"))
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-bashos-"))
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
    resetShellProbeForTests()
  })

  it("stays on the policy path (no marker) where no isolator exists, flag or not", async () => {
    process.env[FLAG] = "1"
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-bashos-"))
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-bashos-"))
    const original = Object.getOwnPropertyDescriptor(process, "platform")
    setWindowsAcProbeForTests(() => true)
    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
    seedShellProbeForTests(SHELL, { ok: true })
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

  it("a failed shell probe parks the session on the policy path with an honest note", async () => {
    process.env[FLAG] = "1"
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-bashos-"))
    const original = Object.getOwnPropertyDescriptor(process, "platform")
    setWindowsAcProbeForTests(() => true)
    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
    try {
      // Probe call: sandboxed, but our own `exit 0` payload fails — the
      // shell chain cannot survive the isolator (Git's dispatcher-stub
      // case). The real command then runs through the policy path: the
      // injected spawner must see exactly one call (the probe), because
      // the verdict is cached for the whole session.
      const spawnFn = vi.fn(async () => stubProc({ waitForExit: async () => 1 }))
      const tool = createBashTool({ spawnFn: spawnFn as never })
      const first = await tool.execute("t1", { command: "echo probe-degraded" }, undefined, undefined, ctxFor(dir))

      expect(spawnFn).toHaveBeenCalledTimes(1) // only the probe
      expect(textOf(first)).toContain("probe-degraded") // the command still ran
      expect(textOf(first)).toContain("[sandbox: policy-only — shell cannot run under windows-restricted isolation]")
      expect(textOf(first)).not.toContain("[sandbox: os")

      const second = await tool.execute("t1", { command: "echo again" }, undefined, undefined, ctxFor(dir))
      expect(spawnFn).toHaveBeenCalledTimes(1) // cached — no second probe
      expect(textOf(second)).toContain("[sandbox: policy-only —")
    } finally {
      if (original) Object.defineProperty(process, "platform", original)
      setWindowsAcProbeForTests(null)
      resetShellProbeForTests()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("a passing probe is cached and the real run keeps its OS marker", async () => {
    process.env[FLAG] = "1"
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-bashos-"))
    const original = Object.getOwnPropertyDescriptor(process, "platform")
    setWindowsAcProbeForTests(() => true)
    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
    try {
      const spawnFn = vi.fn(async (_request: SpawnRequest) =>
        stubProc({ sandboxType: SandboxType.WindowsRestrictedToken }),
      )
      const tool = createBashTool({ spawnFn: spawnFn as never })
      const first = await tool.execute("t1", { command: "echo os-path" }, undefined, undefined, ctxFor(dir))

      // First run: the probe (our trivial payload) + the real command.
      expect(spawnFn).toHaveBeenCalledTimes(2)
      expect(spawnFn.mock.calls[0]?.[0].command.slice(-1)).toEqual(["exit 0"])
      expect(spawnFn.mock.calls[1]?.[0].command.slice(-1)).toEqual(["echo os-path"])
      expect(textOf(first)).toContain("[sandbox: os (windows_sandbox)]")

      // Verdict cached: the second run spawns only the real command.
      const second = await tool.execute("t1", { command: "echo os-path-2" }, undefined, undefined, ctxFor(dir))
      expect(spawnFn).toHaveBeenCalledTimes(3)
      expect(textOf(second)).toContain("[sandbox: os (windows_sandbox)]")
    } finally {
      if (original) Object.defineProperty(process, "platform", original)
      setWindowsAcProbeForTests(null)
      resetShellProbeForTests()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("background OS jobs capture output end-to-end (readAll attached before waitForExit)", async () => {
    process.env[FLAG] = "1"
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-bashos-"))
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
      seedShellProbeForTests(SHELL, { ok: true })
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

/**
 * The reported bug, end to end: the default Windows shell
 * (`detectDefaultShell()` → Git's dispatcher stub `Git\bin\bash.exe`)
 * chains into the real `usr\bin\bash.exe`, which dies in DllMain inside
 * the AppContainer (MSYS's `NtCreateDirectoryObject(\BaseNamedObjects\…)`
 * → 0xC0000022 → exit 0xC0000142) before the command's first
 * instruction. The session probe must see that chain fail exactly once,
 * park the run on the policy path, and let the command actually work — no
 * fatal error, no claim of isolation that was not applied.
 */
describe.runIf(process.platform === "win32" && fs.existsSync("C:\\Program Files\\Git\\bin\\bash.exe"))(
  "bash session probe vs Git's dispatcher stub",
  () => {
    afterEach(() => {
      if (savedFlag === undefined) delete process.env[FLAG]
      else process.env[FLAG] = savedFlag
      resetBackgroundJobsForTests()
      resetShellProbeForTests()
      setWindowsAcProbeForTests(null)
    })

    it("runs the default Windows shell policy-only instead of dying in DllMain", async () => {
      process.env[FLAG] = "1"
      setWindowsAcProbeForTests(() => true) // infra probe passes, as on the user's machine
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-bashos-"))
      try {
        const base = ctxFor(dir)
        const ctx = {
          ...base,
          config: { ...base.config, shellCommand: '"C:\\Program Files\\Git\\bin\\bash.exe" -c' },
        } as ToolContext
        const tool = createBashTool() // REAL spawner: the AppContainer shim must really engage
        const result = await tool.execute("t1", { command: "echo probe-ok" }, undefined, undefined, ctx)
        const text = textOf(result)

        expect(result.isError).toBeFalsy()
        expect(text).toContain("probe-ok") // the command actually ran
        expect(text).not.toContain("fatal error") // the bug's signature
        expect(text).not.toContain("NtCreateDirectoryObject")
        expect(text).toContain("[sandbox: policy-only")
        expect(text).not.toContain("[sandbox: os")
      } finally {
        resetShellProbeForTests()
        setWindowsAcProbeForTests(null)
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }, 120_000)
  },
)
