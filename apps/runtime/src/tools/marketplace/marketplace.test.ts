/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createMarketplaceTool,
  installMarketplaceEntry,
  removeMarketplaceEntry,
  scanMarketplace,
  searchMarketplace,
} from "./marketplace.js"

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
  shelf = mkdtempSync(join(tmpdir(), "trayambak-shelf-"))
  mkdirSync(join(shelf, "skills", "reviewer"), { recursive: true })
  writeFileSync(
    join(shelf, "skills", "reviewer", "SKILL.md"),
    "---\nname: reviewer\ndescription: Reviews code for bugs\n---\n\nBody.\n",
  )
  mkdirSync(join(shelf, "agents"), { recursive: true })
  writeFileSync(
    join(shelf, "agents", "architect.md"),
    "---\nname: architect\ndescription: Designs systems\n---\n\nPersona.\n",
  )
  writeFileSync(join(shelf, "agents", "notes.txt"), "not an agent\n")
  return shelf
}

describe("scanMarketplace", () => {
  it("lists skills and agents with descriptions", () => {
    const entries = scanMarketplace(makeShelf())

    expect(entries).toEqual([
      { kind: "agent", name: "architect", description: "Designs systems" },
      { kind: "skill", name: "reviewer", description: "Reviews code for bugs" },
    ])
  })

  it("treats a missing shelf as empty, not an error", () => {
    shelf = mkdtempSync(join(tmpdir(), "trayambak-shelf-"))

    expect(scanMarketplace(shelf)).toEqual([])
  })
})

describe("searchMarketplace", () => {
  it("matches names and descriptions case-insensitively", () => {
    const dir = makeShelf()

    expect(searchMarketplace(dir, "REVIEW").map((e) => e.name)).toEqual(["reviewer"])
    expect(searchMarketplace(dir, "systems").map((e) => e.name)).toEqual(["architect"])
    expect(searchMarketplace(dir, "nothing-here")).toEqual([])
    expect(searchMarketplace(dir, "   ")).toEqual([])
  })
})

describe("installMarketplaceEntry / removeMarketplaceEntry", () => {
  it("installs a skill bundle and an agent card into the project", () => {
    const dir = makeShelf()
    project = mkdtempSync(join(tmpdir(), "trayambak-proj-"))

    expect(installMarketplaceEntry(dir, "skill", "reviewer", project).ok).toBe(true)
    expect(installMarketplaceEntry(dir, "agent", "architect", project).ok).toBe(true)
    expect(readFileSync(join(project, ".trayambak", "skills", "reviewer", "SKILL.md"), "utf8")).toContain(
      "Reviews code",
    )
    expect(readFileSync(join(project, ".trayambak", "agents", "architect.md"), "utf8")).toContain("Persona.")

    expect(removeMarketplaceEntry("skill", "reviewer", project).ok).toBe(true)
    expect(existsSync(join(project, ".trayambak", "skills", "reviewer"))).toBe(false)
    expect(removeMarketplaceEntry("agent", "architect", project).ok).toBe(true)
  })

  it("refuses overwrites, missing entries, bad names, and missing installs", () => {
    const dir = makeShelf()
    project = mkdtempSync(join(tmpdir(), "trayambak-proj-"))

    expect(installMarketplaceEntry(dir, "skill", "ghost", project)).toMatchObject({ ok: false })
    expect(installMarketplaceEntry(dir, "agent", "ghost", project)).toMatchObject({ ok: false })
    expect(installMarketplaceEntry(dir, "skill", "../evil", project)).toMatchObject({ ok: false })
    expect(removeMarketplaceEntry("skill", "ghost", project)).toMatchObject({ ok: false })
    expect(removeMarketplaceEntry("agent", "../evil", project)).toMatchObject({ ok: false })

    expect(installMarketplaceEntry(dir, "skill", "reviewer", project).ok).toBe(true)
    expect(installMarketplaceEntry(dir, "skill", "reviewer", project)).toMatchObject({ ok: false })
  })
})

describe("createMarketplaceTool", () => {
  it("exposes the marketplace identity", () => {
    expect(createMarketplaceTool().definition.name).toBe("marketplace")
  })

  it("lists, searches, installs, and removes through tool calls", async () => {
    const dir = makeShelf()
    project = mkdtempSync(join(tmpdir(), "trayambak-proj-"))
    const tool = createMarketplaceTool(dir)
    const ctx = { cwd: project } as never
    const body = (r: { content: Array<{ text?: string }> }): string => r.content.map((c) => c.text ?? "").join()

    const listed = await tool.execute("t1", { action: "list" }, undefined, undefined, ctx)
    expect(listed.isError).toBe(false)
    expect(body(listed)).toContain("[skill] reviewer")

    const searched = await tool.execute("t1", { action: "search", query: "architect" }, undefined, undefined, ctx)
    expect(body(searched)).toContain("architect")

    const installed = await tool.execute(
      "t1",
      { action: "install", kind: "skill", name: "reviewer" },
      undefined,
      undefined,
      ctx,
    )
    expect(installed.isError).toBe(false)
    expect(existsSync(join(project, ".trayambak", "skills", "reviewer", "SKILL.md"))).toBe(true)

    const removed = await tool.execute(
      "t1",
      { action: "remove", kind: "skill", name: "reviewer" },
      undefined,
      undefined,
      ctx,
    )
    expect(removed.isError).toBe(false)

    const bad = await tool.execute("t1", { action: "teleport" }, undefined, undefined, ctx)
    expect(bad.isError).toBe(true)
  })
})
