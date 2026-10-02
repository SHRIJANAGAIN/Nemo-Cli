/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * ProcessManager behaviour — the exec path behind the `bash` tool.
 *
 * Cases run real child processes via `process.execPath` so they hold on
 * Windows and Linux CI alike, and every long-lived child is killed before the
 * case ends so no handle outlives the run. Constants are deliberately not
 * asserted here: a test that pins a statically defined literal only restates
 * the source.
 */
import { describe, expect, it } from "vitest"
import { ProcessManager, combineTokens, createCancellationToken } from "./process.js"

const node = process.execPath

/** A faithful copy of the ambient environment, typed as the API requires. */
function childEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

function spawnWith(pm: ProcessManager, script: string, extra: Record<string, unknown> = {}) {
  return pm.spawn({
    command: [node, "-e", script],
    cwd: process.cwd(),
    env: childEnv(),
    ...extra,
  } as Parameters<ProcessManager["spawn"]>[0])
}

/**
 * True iff a process group with id `pid` exists — i.e. `pid` leads its own
 * group. `getpgid` is not exposed by Node, so this probes the group with
 * signal 0 exactly the way `killProcessGroup` targets it with a real signal.
 */
function leadsOwnProcessGroup(pid: number): boolean {
  if (process.platform === "win32") return false
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

describe("ProcessManager.spawn output capture", () => {
  it("captures stdout and reports a zero exit code", async () => {
    const pm = new ProcessManager()
    const handle = await spawnWith(pm, 'process.stdout.write("hello")')
    expect(await handle.exitCode).toBe(0)
    expect(await handle.output).toBe("hello")
    expect(pm.activeCount).toBe(0)
  })

  it("captures stderr as part of the same stream", async () => {
    const pm = new ProcessManager()
    const handle = await spawnWith(pm, 'process.stderr.write("to stderr")')
    expect(await handle.exitCode).toBe(0)
    expect(await handle.output).toBe("to stderr")
  })

  it("interleaves stdout and stderr in arrival order", async () => {
    const pm = new ProcessManager()
    const handle = await spawnWith(
      pm,
      'process.stdout.write("a"); process.stderr.write("b"); process.stdout.write("c")',
    )
    expect(await handle.exitCode).toBe(0)
    expect((await handle.output).split("").sort().join("")).toBe("abc")
  })

  it("propagates a non-zero exit code", async () => {
    const pm = new ProcessManager()
    const handle = await spawnWith(pm, "process.exit(3)")
    expect(await handle.exitCode).toBe(3)
  })

  it("reports a spawn failure as exit code 1", async () => {
    const pm = new ProcessManager()
    const handle = await pm.spawn({
      command: ["trayambak-binary-that-does-not-exist-xyz"],
      cwd: process.cwd(),
      env: childEnv(),
    })
    expect(await handle.exitCode).toBe(1)
    expect(pm.activeCount).toBe(0)
  })
})

describe("ProcessManager output capping", () => {
  it("never returns more than outputCap bytes", async () => {
    const cap = 512
    const pm = new ProcessManager()
    const handle = await spawnWith(pm, 'process.stdout.write("y".repeat(200000))', { outputCap: cap })
    expect(await handle.exitCode).toBe(0)
    const out = await handle.output
    expect(out.length).toBeGreaterThan(0)
    expect(out.length).toBeLessThanOrEqual(cap)
  })

  it("leaves output untouched when it already fits the cap", async () => {
    const pm = new ProcessManager()
    const handle = await spawnWith(pm, 'process.stdout.write("small")', { outputCap: 4096 })
    expect(await handle.output).toBe("small")
  })
})

describe("ProcessManager lifecycle", () => {
  it("tracks a running child until it exits", async () => {
    const pm = new ProcessManager()
    const handle = await spawnWith(pm, "process.exit(0)")
    expect(pm.activeCount).toBe(1)
    await handle.exitCode
    expect(pm.activeCount).toBe(0)
  })

  it("kill() terminates a long-running child", async () => {
    const pm = new ProcessManager()
    const handle = await spawnWith(pm, "setInterval(() => {}, 1000)")
    expect(pm.activeCount).toBe(1)
    await handle.kill()
    expect(await handle.exitCode).not.toBe(0)
    expect(pm.activeCount).toBe(0)
  })

  it("killAll() stops every tracked child and empties the registry", async () => {
    const pm = new ProcessManager()
    const a = await spawnWith(pm, "setInterval(() => {}, 1000)")
    const b = await spawnWith(pm, "setInterval(() => {}, 1000)")
    expect(pm.activeCount).toBe(2)

    await pm.killAll()

    expect(pm.activeCount).toBe(0)
    expect(await a.exitCode).not.toBe(0)
    expect(await b.exitCode).not.toBe(0)
  })

  it("terminates the child when the abort signal fires", async () => {
    const pm = new ProcessManager()
    const controller = new AbortController()
    const handle = await spawnWith(pm, "setInterval(() => {}, 1000)", { signal: controller.signal })
    expect(pm.activeCount).toBe(1)

    controller.abort()

    await expect(handle.exitCode).rejects.toThrow("Process aborted")
    expect(pm.activeCount).toBe(0)
  })

  it("rejects exitCode when the command times out", async () => {
    const pm = new ProcessManager()
    const handle = await spawnWith(pm, "setInterval(() => {}, 1000)", { timeoutMs: 250 })

    await expect(handle.exitCode).rejects.toThrow("Command timed out after 250ms")
    expect(pm.activeCount).toBe(0)
    // The killed child's pipes still close, so partial output is delivered.
    await expect(handle.output).resolves.toBeTypeOf("string")
  })

  it("rejects spawn() itself when the signal is already aborted", async () => {
    const pm = new ProcessManager()
    const controller = new AbortController()
    controller.abort()

    await expect(
      pm.spawn({
        command: [node, "-e", 'process.stdout.write("never runs")'],
        cwd: process.cwd(),
        env: childEnv(),
        signal: controller.signal,
      }),
    ).rejects.toThrow("Process aborted")
    expect(pm.activeCount).toBe(0)
  })

  const posixOnly = process.platform === "win32" ? it.skip : it

  posixOnly("processGroup:true makes the child its own process-group leader", async () => {
    const pm = new ProcessManager()

    const grouped = await spawnWith(pm, "setInterval(() => {}, 1000)", { processGroup: true })
    expect(leadsOwnProcessGroup(grouped.pid)).toBe(true)

    const plain = await spawnWith(pm, "setInterval(() => {}, 1000)")
    expect(leadsOwnProcessGroup(plain.pid)).toBe(false)

    await pm.killAll()
    expect(pm.activeCount).toBe(0)
  })

  it("ignores a process group whose process already exited", async () => {
    const pm = new ProcessManager()
    const handle = await spawnWith(pm, "process.exit(0)")
    const { pid } = handle
    await handle.exitCode
    await expect(pm.killProcessGroup(pid)).resolves.toBeUndefined()
  })
})

describe("cancellation tokens", () => {
  it("starts uncancelled and flips on cancel()", () => {
    const { token, cancel, isCancelled } = createCancellationToken()
    expect(isCancelled()).toBe(false)
    expect(token.signal.aborted).toBe(false)
    cancel()
    expect(isCancelled()).toBe(true)
    expect(token.signal.aborted).toBe(true)
  })

  it("combines two controllers so either can abort the result", () => {
    const first = new AbortController()
    const second = new AbortController()
    const combined = combineTokens(first, second)
    expect(combined.signal.aborted).toBe(false)

    second.abort()
    expect(combined.signal.aborted).toBe(true)
  })

  it("propagates an abort raised on the first input", () => {
    const first = new AbortController()
    const second = new AbortController()
    const combined = combineTokens(first, second)
    expect(combined.signal.aborted).toBe(false)

    first.abort()
    expect(combined.signal.aborted).toBe(true)
  })
})

describe("shell-pattern argv quoting (#75)", () => {
  it("keeps the user's quotes intact through [shell, -c, <command>]", async () => {
    // The [shell, -c, rawText] pattern must reach the shell exactly as
    // typed. Without windowsVerbatimArguments, CRT-escaping turns the
    // quotes into `\"` on Windows and cmd.exe echoes them back literally
    // (`\"quoted-ok\"`).
    const pm = new ProcessManager()
    const shell = process.platform === "win32" ? ["cmd", "/c"] : ["/bin/sh", "-c"]
    const handle = await pm.spawn({
      command: [...shell, `echo "quoted-ok"`],
      cwd: process.cwd(),
      env: childEnv(),
      windowsVerbatimArguments: true,
    })
    const out = await handle.output
    const code = await handle.exitCode.catch(() => 1)
    expect(code).toBe(0)
    expect(out).toContain("quoted-ok")
    expect(out).not.toContain('\\"')
  })
})
