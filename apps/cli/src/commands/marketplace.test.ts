/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { marketplaceCommand } from "./marketplace.js"

let shelf = ""
let project = ""

afterEach(() => {
  for (const dir of [shelf, project]) {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
  shelf = ""
  project = ""
})

function makeShelf(): string {
  shelf = mkdtempSync(join(tmpdir(), "trayambak-mkt-"))
  mkdirSync(join(shelf, "skills", "reviewer"), { recursive: true })
  writeFileSync(join(shelf, "skills", "reviewer", "SKILL.md"), "---\nname: reviewer\ndescription: Reviews\n---\n\nB\n")
  return shelf
}

describe("marketplaceCommand", () => {
  it("lists and searches the shelf", () => {
    const dir = makeShelf()

    expect(marketplaceCommand({ action: "list", source: dir })).toContain("[skill] reviewer")
    expect(marketplaceCommand({ action: "search", nameOrQuery: "review", source: dir })).toContain("reviewer")
    expect(marketplaceCommand({ action: "search", nameOrQuery: "zzz", source: dir })).toContain(
      "No marketplace entries",
    )
    expect(marketplaceCommand({ action: "search", source: dir })).toContain("Usage:")
  })

  it("installs and removes through the CLI", () => {
    const dir = makeShelf()
    project = mkdtempSync(join(tmpdir(), "trayambak-mktproj-"))

    expect(
      marketplaceCommand({ action: "install", kind: "skill", nameOrQuery: "reviewer", source: dir, cwd: project }),
    ).toContain("Installed skill")
    expect(existsSync(join(project, ".trayambak", "skills", "reviewer", "SKILL.md"))).toBe(true)
    expect(marketplaceCommand({ action: "remove", kind: "skill", nameOrQuery: "reviewer", cwd: project })).toContain(
      "Removed",
    )
    expect(marketplaceCommand({ action: "install", kind: "nope", nameOrQuery: "x", source: dir })).toContain("Usage:")
  })

  it("rejects unknown actions", () => {
    expect(marketplaceCommand({ action: "buy" })).toContain("Unknown marketplace action")
  })
})
