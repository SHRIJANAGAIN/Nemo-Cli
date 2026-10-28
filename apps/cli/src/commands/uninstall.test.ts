/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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
  home = mkdtempSync(join(tmpdir(), "nemo-uninstall-"))
  return home
}

describe("uninstallCommand (windows layout)", () => {
  it("removes both shims and clears NEMO_HOME", () => {
    const dir = tempHome()
    const bin = join(dir, "bin")
    const t = join(bin, "nemo.cmd")
    const s = join(bin, "nemo-code.cmd")
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
    expect(setxArgs).toEqual([["NEMO_HOME", ""]])
    expect(out).toContain("removed shim")
    expect(out).toContain("cleared NEMO_HOME")
    expect(out).toContain("kept: config, sessions, and state")
  })

  it("skips missing shims and reports a failed setx honestly", () => {
    const dir = tempHome()

    const out = uninstallCommand({ homeDir: dir, platform: "win32", setx: () => 1 })

    expect(out).toContain("shim not found (skipped)")
    expect(out).toContain("could not clear NEMO_HOME")
  })
})

describe("uninstallCommand (posix layout)", () => {
  it("removes ~/.local/bin launchers without touching setx", () => {
    const dir = tempHome()
    mkdirSync(join(dir, ".local", "bin"), { recursive: true })
    writeFileSync(join(dir, ".local", "bin", "nemo"), "shim")
    let setxCalled = false

    const out = uninstallCommand({
      homeDir: dir,
      platform: "linux",
      setx: () => {
        setxCalled = true
        return 0
      },
    })

    expect(existsSync(join(dir, ".local", "bin", "nemo"))).toBe(false)
    expect(setxCalled).toBe(false)
    expect(out).toContain("shim not found (skipped)")
    expect(out).toContain("npm rm -g")
  })
})
