/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"

import { isUpgradeFailure, upgradeCommand } from "./upgrade.js"

const dirs: string[] = []

function makeRoot(version = "0.3.0", name = "Nemo"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-cmd-"))
  dirs.push(dir)
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }), "utf8")
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

describe("upgradeCommand", () => {
  it("prints manual guidance for source installs (no git, no registry)", async () => {
    const root = makeRoot()
    const output = await upgradeCommand({ startDir: root, argvPath: path.join(root, "dist", "index.js"), env: {} })
    expect(output).toContain("installed from a source copy without git")
    expect(output).toContain("npm run build")
    expect(output).toContain("0.3.0")
  })

  it("fails with guidance when no installation root can be found", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-none-"))
    dirs.push(dir)
    const output = await upgradeCommand({ startDir: dir, argvPath: path.join(dir, "index.js"), env: {} })
    expect(output).toContain("could not locate the nemo installation")
    expect(output).toContain("NEMO_HOME")
  })

  it("marks Upgrade-failed outputs as failures, guidance as success (exit-code contract)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-none-"))
    dirs.push(dir)
    const failed = await upgradeCommand({ startDir: dir, argvPath: path.join(dir, "index.js"), env: {} })
    expect(isUpgradeFailure(failed)).toBe(true)

    const root = makeRoot()
    const guidance = await upgradeCommand({ startDir: root, argvPath: path.join(root, "dist", "index.js"), env: {} })
    expect(isUpgradeFailure(guidance)).toBe(false)
    expect(isUpgradeFailure("nemo 1.0.0 is already the requested version.")).toBe(false)
  })

  it("rejects a target version that could inject shell syntax (#66)", async () => {
    const root = makeRoot()
    const output = await upgradeCommand({
      target: "1.0.0 & calc",
      startDir: root,
      argvPath: path.join(root, "dist", "index.js"),
      env: {},
    })
    expect(output).toContain("Upgrade failed")
    expect(output).toContain("invalid target version")
    expect(output).toContain("1.0.0 & calc")
  })

  it("accepts a well-formed prerelease target token (#66)", async () => {
    const root = makeRoot()
    // Source installs never execute anything — reaching the manual-guidance
    // branch proves the token passed validation instead of erroring out.
    const output = await upgradeCommand({
      target: "1.2.3-rc.1",
      startDir: root,
      argvPath: path.join(root, "dist", "index.js"),
      env: {},
    })
    expect(output).toContain("installed from a source copy without git")
  })

  it("does not confuse a git PROJECT directory with the nemo install root", async () => {
    // The user's own repo having .git must not flip the method to "git" —
    // detection walks from the install root, not the session cwd.
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-project-"))
    dirs.push(project)
    fs.mkdirSync(path.join(project, ".git"))
    const root = makeRoot()
    const output = await upgradeCommand({ startDir: root, argvPath: path.join(root, "dist", "index.js"), env: {} })
    expect(output).toContain("installed from a source copy without git")
  })
})
