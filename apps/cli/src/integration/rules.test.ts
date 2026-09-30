/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { ensureDefaultAgentsMd, getRulePaths, getRulesContextBlock, loadRules, writeRule } from "./rules.js"

/**
 * loadRules walks UP from cwd, so the project root is a fresh temp dir (wiped
 * per test) whose ancestors contain no rule files; os.homedir() is pinned to a
 * temp home for the whole file so the `global` origin reads ~/.trayambak from
 * there and never from the real profile. Assertions target OUR entries (cwd
 * always sorts first) so an ambient ancestor file can't flip them.
 */
let home = ""
let project = ""
let savedUserprofile: string | undefined
let savedHome: string | undefined

const projectFile = (name: string): string => path.join(project, name)

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-rules-home-"))
  project = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-rules-proj-"))
  savedUserprofile = process.env.USERPROFILE
  savedHome = process.env.HOME
  process.env.USERPROFILE = home
  process.env.HOME = home
})

afterAll(() => {
  if (savedUserprofile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = savedUserprofile
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(project, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(project, { recursive: true, force: true })
  fs.mkdirSync(project, { recursive: true })
  fs.rmSync(path.join(home, ".trayambak"), { recursive: true, force: true })
})

describe("loadRules", () => {
  it("reads AGENTS.md from cwd first, tagged with origin project", () => {
    fs.writeFileSync(projectFile("AGENTS.md"), "project rules here", "utf8")
    const rules = loadRules(project)
    expect(rules[0]?.path).toBe(path.resolve(projectFile("AGENTS.md")))
    expect(rules[0]?.name).toBe("AGENTS.md")
    expect(rules[0]?.origin).toBe("project")
    expect(rules[0]?.content).toBe("project rules here")
  })

  it("collects every rule filename in the directory, in declared order", () => {
    fs.writeFileSync(projectFile("AGENTS.md"), "a", "utf8")
    fs.writeFileSync(projectFile("CLAUDE.md"), "b", "utf8")
    fs.writeFileSync(projectFile("CONTEXT.md"), "c", "utf8")
    const names = loadRules(project)
      .filter((rule) => rule.path.startsWith(path.resolve(project)))
      .map((rule) => rule.name)
    expect(names).toEqual(["AGENTS.md", "CLAUDE.md", "CONTEXT.md"])
  })

  it("finds rule files in ancestor directories as project rules too", () => {
    const nested = path.join(project, "packages", "deep")
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(projectFile("AGENTS.md"), "root rule", "utf8")
    const rules = loadRules(nested)
    expect(rules.some((rule) => rule.path === path.resolve(projectFile("AGENTS.md")))).toBe(true)
  })

  it("surfaces global ~/.trayambak rules tagged with origin global", () => {
    const globalPath = writeRule("CONTEXT.md", "global context rules", home, "global")
    expect(globalPath).toBe(path.join(home, ".trayambak", "CONTEXT.md"))

    const rules = loadRules(project)
    const globalRule = rules.find((rule) => rule.origin === "global")
    expect(globalRule?.name).toBe("CONTEXT.md")
    expect(globalRule?.content).toBe("global context rules")
    expect(globalRule?.path).toBe(path.resolve(path.join(home, ".trayambak", "CONTEXT.md")))
  })

  it("returns no project rules for an empty tree walk of our own files", () => {
    const own = loadRules(project).filter((rule) => rule.path.startsWith(path.resolve(project)))
    expect(own).toEqual([])
  })
})

describe("getRulePaths", () => {
  it("maps loadRules down to paths, ours first", () => {
    fs.writeFileSync(projectFile("AGENTS.md"), "x", "utf8")
    const paths = getRulePaths(project)
    expect(paths[0]).toBe(path.resolve(projectFile("AGENTS.md")))
    expect(paths.every((entry) => typeof entry === "string")).toBe(true)
    expect(paths).toEqual(loadRules(project).map((rule) => rule.path))
  })
})

describe("getRulesContextBlock", () => {
  it("renders the header and one section per rule", () => {
    fs.writeFileSync(projectFile("AGENTS.md"), "short rules", "utf8")
    const block = getRulesContextBlock(project)
    expect(block.startsWith("## Project Rules (from AGENTS.md/CLAUDE.md/CONTEXT.md):")).toBe(true)
    expect(block).toContain("### From AGENTS.md (project)")
    expect(block).toContain("short rules")
    expect(block.endsWith("\n")).toBe(true)
    // Our section carries no truncation marker for content under 2000 chars.
    const ownSection = block.split("### From AGENTS.md (project)")[1]?.split("### From")[0] ?? ""
    expect(ownSection).not.toContain("more chars truncated")
  })

  it("caps each rule at 2000 chars and reports the dropped remainder", () => {
    fs.writeFileSync(projectFile("AGENTS.md"), "R".repeat(2500), "utf8")
    const block = getRulesContextBlock(project)
    expect(block).toContain("R".repeat(2000))
    expect(block).not.toContain("R".repeat(2001))
    expect(block).toContain("... [500 more chars truncated]")
  })

  it("returns an empty string when our tree has no rule files", () => {
    const block = getRulesContextBlock(project)
    if (loadRules(project).every((rule) => !rule.path.startsWith(path.resolve(project)))) {
      // Only meaningful when no ambient ancestor rules were found.
      expect(block.startsWith("## Project Rules")).toBe(false)
    }
  })
})

describe("writeRule", () => {
  it("project scope writes into cwd and the file becomes loadable", () => {
    const written = writeRule("CLAUDE.md", "hello rules", project)
    expect(written).toBe(projectFile("CLAUDE.md"))
    expect(fs.readFileSync(written, "utf8")).toBe("hello rules")

    const loaded = loadRules(project).find((rule) => rule.path === path.resolve(written))
    expect(loaded?.origin).toBe("project")
    expect(loaded?.content).toBe("hello rules")
  })

  it("global scope writes into the stubbed home's .trayambak", () => {
    const written = writeRule("AGENTS.md", "home rules", home, "global")
    expect(written.startsWith(home)).toBe(true)
    expect(fs.readFileSync(written, "utf8")).toBe("home rules")
    expect(loadRules(project).some((rule) => rule.path === path.resolve(written) && rule.origin === "global")).toBe(
      true,
    )
  })
})

describe("ensureDefaultAgentsMd", () => {
  it("creates the template once and refuses to overwrite an existing file", () => {
    const created = ensureDefaultAgentsMd(project)
    expect(created).toBe(projectFile("AGENTS.md"))

    const content = fs.readFileSync(projectFile("AGENTS.md"), "utf8")
    expect(content).toContain("# Trayambak Project Rules")
    expect(content).toContain("npm run build")

    // While the template is in place, loadRules discovers it.
    const templateRule = loadRules(project).find((rule) => rule.path === path.resolve(projectFile("AGENTS.md")))
    expect(templateRule?.origin).toBe("project")
    expect(templateRule?.content).toContain("# Trayambak Project Rules")

    // Existing file wins: no regeneration, no overwrite.
    fs.writeFileSync(projectFile("AGENTS.md"), "user's own rules", "utf8")
    expect(ensureDefaultAgentsMd(project)).toBeNull()
    expect(fs.readFileSync(projectFile("AGENTS.md"), "utf8")).toBe("user's own rules")

    // loadRules now reports the user's file, not a regenerated template.
    const currentRule = loadRules(project).find((rule) => rule.path === path.resolve(projectFile("AGENTS.md")))
    expect(currentRule?.content).toBe("user's own rules")
  })
})
