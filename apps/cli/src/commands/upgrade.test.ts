/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"

import { upgradeCommand } from "./upgrade.js"

const dirs: string[] = []

function makeRoot(version = "0.3.0", name = "Trayambak"): string {
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
    expect(output).toContain("could not locate the trayambak installation")
    expect(output).toContain("TRAYAMBAK_HOME")
  })

  it("does not confuse a git PROJECT directory with the trayambak install root", async () => {
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
