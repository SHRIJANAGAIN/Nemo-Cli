/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * OS-level spawner behaviour (spawn.ts).
 *
 * The pure pieces — seatbelt profile text and bubblewrap argument
 * construction — are exported precisely so they can be pinned on any host;
 * process-level cases spawn real children via process.execPath. Each case
 * targets a defect the module used to ship: ignored timeoutMs, ignored
 * outputCap, JSON-in-a-.sbpl-file, invalid bwrap flags, a dead mount pair,
 * a lying Windows handle (now the AppContainer shim with an honest
 * fallback), a drain timer that rejected any command outliving
 * IO_DRAIN_TIMEOUT_MS, and a processGroupId that pointed at a group the
 * child did not lead.
 */
import { describe, expect, it } from "vitest"
import { landlockArgs, seatbeltProfile, spawnProcess } from "./spawn.js"
import { FileSystemSandboxPolicy, NetworkSandboxPolicy, SandboxType, SpawnRequest } from "./types.js"
import { setWindowsAcProbeForTests } from "./windows-ac.js"

const node = process.execPath
const posixOnly = process.platform === "win32" ? it.skip : it

function childEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

function netPolicy(disableNetwork: boolean): NetworkSandboxPolicy {
  return { disableNetwork, allowedDomains: [], blockedDomains: [] }
}

function noFilesystemPolicy(): FileSystemSandboxPolicy {
  return { writableRoots: [], readOnlySubpaths: [], denyReadPaths: [], denyWritePaths: [] }
}

function request(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    command: [node, "-e", "process.stdout.write('out')"],
    cwd: process.cwd(),
    sandboxType: SandboxType.None,
    env: childEnv(),
    networkPolicy: netPolicy(false),
    filesystemPolicy: noFilesystemPolicy(),
    outputCap: 64 * 1024,
    timeoutMs: 5_000,
    ...overrides,
  }
}

describe("seatbeltProfile", () => {
  it("emits SBPL text that denies network when the policy disables it", () => {
    const profile = seatbeltProfile(netPolicy(true))
    expect(profile).toContain("(version 1)")
    expect(profile).toContain("(allow default)")
    // Later rules win in SBPL, so the deny must come after the allow.
    expect(profile.indexOf("(deny network*)")).toBeGreaterThan(profile.indexOf("(allow default)"))
  })

  it("leaves the default-allow profile open when network is allowed", () => {
    const profile = seatbeltProfile(netPolicy(false))
    expect(profile).toContain("(allow default)")
    expect(profile).not.toContain("(deny network*)")
  })

  it("never emits JSON — sandbox-exec parses SBPL, not a JSON document", () => {
    for (const policy of [netPolicy(true), netPolicy(false)]) {
      const profile = seatbeltProfile(policy)
      expect(profile).not.toContain("{")
      expect(profile.trim().startsWith("(version 1)")).toBe(true)
    }
  })
})

describe("landlockArgs", () => {
  it("unshares the network namespace only when the policy disables it", () => {
    expect(landlockArgs(["/bin/true"], "/w", netPolicy(true))).toContain("--unshare-net")
    expect(landlockArgs(["/bin/true"], "/w", netPolicy(false))).not.toContain("--unshare-net")
  })

  it("never emits the invalid --net option that killed network-disabled spawns", () => {
    const args = landlockArgs(["/bin/true"], "/w", netPolicy(true))
    expect(args).not.toContain("--net")
    expect(args).not.toContain("/dev/null")
  })

  it("binds cwd exactly once, writable — the old --ro-bind/--bind pair cancelled out", () => {
    const args = landlockArgs(["/bin/true"], "/w", netPolicy(false))
    expect(args.filter((a) => a === "--ro-bind")).toHaveLength(0)
    expect(args.filter((a) => a === "--bind")).toHaveLength(1)
    expect(args).toContain("--die-with-parent")
    expect(args).toContain("--unshare-user")
    expect(args).toContain("--unshare-pid")
  })
})

describe("spawnProcess", () => {
  it("runs a command and reports the unsandboxed truth", async () => {
    const proc = await spawnProcess(request())
    expect(proc.isSandboxed).toBe(false)
    expect(proc.sandboxType).toBe(SandboxType.None)
    // Read before waiting: output is only recoverable while the streams are
    // still live (child 'close' destroys them — see the post-close case).
    expect(await proc.readAll()).toBe("out")
    expect(await proc.waitForExit()).toBe(0)
  })

  it("readAll after the child closed resolves empty instead of timing out", async () => {
    const proc = await spawnProcess(request({ command: [node, "-e", "process.stdout.write('bye')"] }))
    expect(await proc.waitForExit()).toBe(0)
    // Late listeners can never fire on destroyed streams; the previous code
    // waited out the full IO drain timeout and then rejected.
    await expect(proc.readAll()).resolves.toBe("")
  })

  it("applies the request outputCap as readAll's default ceiling", async () => {
    const proc = await spawnProcess(
      request({
        command: [node, "-e", "process.stdout.write('y'.repeat(5000))"],
        outputCap: 16,
      }),
    )
    const out = await proc.readAll()
    // Previously outputCap was dropped entirely: readAll fell back to the
    // 256KB constant and returned all 5000 bytes.
    expect(out.startsWith("y".repeat(16))).toBe(true)
    expect(out.length).toBeLessThanOrEqual(80)
    expect(await proc.waitForExit()).toBe(0)
  })

  it("reaps a hung child at timeoutMs — the field used to be ignored", async () => {
    const proc = await spawnProcess(
      request({
        command: [node, "-e", "setInterval(() => {}, 1000)"],
        timeoutMs: 300,
      }),
    )
    expect(await proc.waitForExit()).not.toBe(0)
  })

  it("resolves waitForExit for a child that already exited (no hang)", async () => {
    const proc = await spawnProcess(request({ command: [node, "-e", "process.stdout.write('bye'); process.exit(0)"] }))
    await proc.readAll() // resolves on 'close' — exit already observed
    expect(await proc.waitForExit()).toBe(0)
  })

  it("WindowsRestrictedToken falls back to an honest unsandboxed spawn when the helper probe is off", async () => {
    const proc = await spawnProcess(
      request({ sandboxType: SandboxType.WindowsRestrictedToken, command: [node, "-e", ""] }),
    )
    expect(proc.isSandboxed).toBe(false)
    expect(proc.sandboxType).toBe(SandboxType.None)
    await proc.waitForExit()
  })

  it.runIf(process.platform === "win32")(
    "WindowsRestrictedToken spawns a real AppContainer child when the probe passes",
    async () => {
      setWindowsAcProbeForTests(() => true)
      try {
        const proc = await spawnProcess(
          request({
            sandboxType: SandboxType.WindowsRestrictedToken,
            command: [node, "-e", "console.log('ac-child-out')"],
          }),
        )
        expect(proc.isSandboxed).toBe(true)
        expect(proc.sandboxType).toBe(SandboxType.WindowsRestrictedToken)
        // The AppContainer child inherits the shim's pipes: bytes stream
        // through readAll exactly like every other backend.
        const out = await proc.readAll()
        expect(out).toContain("ac-child-out")
        expect(await proc.waitForExit()).toBe(0)
      } finally {
        setWindowsAcProbeForTests(null)
      }
    },
    60_000,
  )

  it("readAll survives commands longer than the IO drain window instead of rejecting", async () => {
    const proc = await spawnProcess(
      request({
        // 2500ms > IO_DRAIN_TIMEOUT_MS (2000): the old drain timer armed at
        // readAll() call time, so every OS-sandboxed command outliving the
        // window rejected with "IO drain timeout" and lost its output.
        command: [node, "-e", "setTimeout(() => process.stdout.write('late-output'), 2500)"],
        timeoutMs: 15_000,
      }),
    )
    const out = await proc.readAll()
    expect(out).toContain("late-output")
    expect(await proc.waitForExit()).toBe(0)
  })

  it("escalates an aborted signal to a kill", async () => {
    const controller = new AbortController()
    const proc = await spawnProcess(
      request({
        command: [node, "-e", "setInterval(() => {}, 1000)"],
        signal: controller.signal,
      }),
    )
    controller.abort()
    expect(await proc.waitForExit()).not.toBe(0)
  })

  posixOnly("leads its own process group so kill(-pid) reaches grandchildren", async () => {
    const proc = await spawnProcess(request({ command: [node, "-e", "setInterval(() => {}, 1000)"] }))
    expect(proc.processGroupId).toBe(proc.pid)
    // Probe the group the way kill() targets it: it must exist, which only
    // holds when the child was spawned detached (before the fix, this
    // probe threw ESRCH and tree-kills silently missed grandchildren).
    expect(() => process.kill(-proc.pid, 0)).not.toThrow()
    await proc.kill()
    await proc.waitForExit()
  })
})
