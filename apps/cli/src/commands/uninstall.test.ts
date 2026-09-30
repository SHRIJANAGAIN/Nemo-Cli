/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { uninstallCommand } from "./uninstall.js"

let home = ""

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true })
  home = ""
})

function tempHome(): string {
  home = mkdtempSync(join(tmpdir(), "trayambak-uninstall-"))
  return home
}

describe("uninstallCommand (windows layout)", () => {
  it("removes both shims and clears TRAYAMBAK_HOME", () => {
    const dir = tempHome()
    const bin = join(dir, "bin")
    const t = join(bin, "trayambak.cmd")
    const s = join(bin, "skt.cmd")
    mkdirSync(bin, { recursive: true })
    writeFileSync(t, "shim")
    writeFileSync(s, "shim")
    const setxArgs: string[][] = []

    const out = uninstallCommand({
      homeDir: dir,
      platform: "win32",
      setx: (args) => {
        setxArgs.push(args)
        return 0
      },
    })

    expect(existsSync(t)).toBe(false)
    expect(existsSync(s)).toBe(false)
    expect(setxArgs).toEqual([["TRAYAMBAK_HOME", ""]])
    expect(out).toContain("removed shim")
    expect(out).toContain("cleared TRAYAMBAK_HOME")
    expect(out).toContain("kept: config, sessions, and state")
  })

  it("skips missing shims and reports a failed setx honestly", () => {
    const dir = tempHome()

    const out = uninstallCommand({ homeDir: dir, platform: "win32", setx: () => 1 })

    expect(out).toContain("shim not found (skipped)")
    expect(out).toContain("could not clear TRAYAMBAK_HOME")
  })
})

describe("uninstallCommand (posix layout)", () => {
  it("removes ~/.local/bin launchers without touching setx", () => {
    const dir = tempHome()
    mkdirSync(join(dir, ".local", "bin"), { recursive: true })
    writeFileSync(join(dir, ".local", "bin", "trayambak"), "shim")
    let setxCalled = false

    const out = uninstallCommand({
      homeDir: dir,
      platform: "linux",
      setx: () => {
        setxCalled = true
        return 0
      },
    })

    expect(existsSync(join(dir, ".local", "bin", "trayambak"))).toBe(false)
    expect(setxCalled).toBe(false)
    expect(out).toContain("shim not found (skipped)")
    expect(out).toContain("npm rm -g")
  })
})
