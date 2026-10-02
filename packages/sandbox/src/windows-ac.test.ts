/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * windows-ac.ts units: the argv quoting handed to CreateProcessW, the
 * capability-SID choice, the capability probe seam, and the shim script's
 * static contract. The shim itself execs system binaries (PowerShell, the
 * helper compile), so its runtime behaviour is pinned by the win32
 * integration test in spawn.test.ts — everything here must stay pure or
 * probe-injected so unit suites never touch the machine.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  acCapabilitySids,
  quoteWindowsArg,
  quoteWindowsArgv,
  setWindowsAcProbeForTests,
  spawnWindowsAcShim,
  taskkillTree,
  windowsAcCapable,
  WINDOWS_AC_PROFILE_NAME,
  WINDOWS_AC_SHIM_SCRIPT,
} from "./windows-ac.js"

afterEach(() => {
  setWindowsAcProbeForTests(null)
  vi.unstubAllEnvs()
})

describe("quoteWindowsArg", () => {
  it("passes plain arguments through untouched", () => {
    expect(quoteWindowsArg("cmd.exe")).toBe("cmd.exe")
    expect(quoteWindowsArg("-c")).toBe("-c")
    expect(quoteWindowsArg("C:\\Windows\\System32\\cmd.exe")).toBe("C:\\Windows\\System32\\cmd.exe")
  })

  it("wraps empty and whitespace-containing arguments in quotes", () => {
    expect(quoteWindowsArg("")).toBe('""')
    expect(quoteWindowsArg("a b")).toBe('"a b"')
  })

  it("backslash-escapes embedded quotes (CommandLineToArgvW rules)", () => {
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""')
  })

  it("doubles trailing backslashes before the closing quote", () => {
    expect(quoteWindowsArg("a b\\")).toBe('"a b\\\\"')
  })
})

describe("quoteWindowsArgv", () => {
  it("joins argv into one command line the shell parses like a plain spawn", () => {
    expect(quoteWindowsArgv(["cmd.exe", "/d", "/s", "/c", "echo hi"])).toBe('cmd.exe /d /s /c "echo hi"')
  })
})

describe("acCapabilitySids", () => {
  it("omits every capability when the network is disabled (kernel block)", () => {
    expect(acCapabilitySids(true)).toEqual([])
  })

  it("grants the three internet capability SIDs when the network is allowed", () => {
    expect(acCapabilitySids(false)).toEqual(["S-1-15-3-1", "S-1-15-3-2", "S-1-15-3-3"])
  })
})

describe("windowsAcCapable", () => {
  it("answers exactly what an injected probe says", () => {
    setWindowsAcProbeForTests(() => true)
    expect(windowsAcCapable()).toBe(true)
    setWindowsAcProbeForTests(() => false)
    expect(windowsAcCapable()).toBe(false)
  })

  it("falls back to the real probe once the seam is removed, and unit environments answer false", () => {
    setWindowsAcProbeForTests(() => true)
    setWindowsAcProbeForTests(null)
    vi.stubEnv("NODE_ENV", "test")
    // Never exec system binaries from a unit suite: the real probe returns
    // false under NODE_ENV=test (and on every non-win32 host anyway).
    expect(windowsAcCapable()).toBe(false)
  })
})

describe("spawnWindowsAcShim guard", () => {
  it("rejects without spawning anything when the probe is off", async () => {
    setWindowsAcProbeForTests(() => false)
    await expect(
      spawnWindowsAcShim({
        command: ["cmd.exe", "/c", "echo hi"],
        cwd: "C:\\",
        env: {},
        networkDisabled: true,
        writableRoots: [],
        denyReadPaths: [],
        denyWritePaths: [],
      }),
    ).rejects.toThrow("windows appcontainer infrastructure unavailable")
  })
})

describe("taskkillTree", () => {
  it("is a safe no-op for empty pids (no taskkill process spawned)", async () => {
    await expect(taskkillTree(0)).resolves.toBeUndefined()
    await expect(taskkillTree(-1)).resolves.toBeUndefined()
  })
})

describe("WINDOWS_AC_SHIM_SCRIPT static contract", () => {
  // The script cannot run inside a unit suite, so these pin the two
  // properties that silently brick it: PowerShell executes top-down, so
  // the C# helper must be assigned before the body reads it; and a single
  // unbalanced here-string terminator would truncate the entire script at
  // parse time. (The ordering bug was found in review of the first draft.)
  it("defines the C# helper before any line that consumes it", () => {
    const helperAssignment = WINDOWS_AC_SHIM_SCRIPT.indexOf("$CSharpHelper = @'")
    const firstUse = WINDOWS_AC_SHIM_SCRIPT.indexOf("$CSharpHelper")
    expect(helperAssignment).toBeGreaterThan(-1)
    expect(firstUse).toBe(helperAssignment)
    expect(helperAssignment).toBeLessThan(WINDOWS_AC_SHIM_SCRIPT.indexOf("Add-Type -TypeDefinition $CSharpHelper"))
  })

  it("keeps exactly one balanced here-string pair", () => {
    const opens = WINDOWS_AC_SHIM_SCRIPT.match(/@'/g)?.length ?? 0
    const closes = WINDOWS_AC_SHIM_SCRIPT.match(/^'@$/gm)?.length ?? 0
    expect(opens).toBe(1)
    expect(closes).toBe(1)
  })

  it("spawns the AppContainer child with inherited handles and no custom env", () => {
    // Both are hard-won platform facts: STARTF_USESTDHANDLES crashes AC
    // children (0xC0000142), and a custom lpEnvironment is rejected with
    // error 203 alongside the security-capabilities attribute.
    expect(WINDOWS_AC_SHIM_SCRIPT).toContain("IntPtr.Zero, cwd, ref siex, out pi)")
    expect(WINDOWS_AC_SHIM_SCRIPT).not.toContain("STARTF_USESTDHANDLES")
    expect(WINDOWS_AC_SHIM_SCRIPT).not.toContain("block.Append")
  })

  it("reports readiness through the status handshake before waiting", () => {
    expect(WINDOWS_AC_SHIM_SCRIPT).toContain("Write-Status $true '' $acPid")
    expect(WINDOWS_AC_SHIM_SCRIPT).toContain("$cfg.statusPath")
    expect(WINDOWS_AC_PROFILE_NAME).toBe("TrayambakSandbox")
  })

  it("holds the spawn-time process handle so exit codes survive child death", () => {
    // A dead process with no open handles is destroyed immediately, so a
    // post-mortem OpenProcess fails — ExitCode() used to return 1 for
    // every sandboxed command. The spawn-time hProcess must be kept (and
    // consumed by ExitCode), never closed at spawn.
    expect(WINDOWS_AC_SHIM_SCRIPT).toContain("s_held[pi.dwProcessId] = pi.hProcess")
    expect(WINDOWS_AC_SHIM_SCRIPT).toContain("s_held.Remove(pid)")
    expect(WINDOWS_AC_SHIM_SCRIPT).not.toContain("CloseHandle(pi.hProcess)")
  })
})
