/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  parsePromptFile,
  loadPromptCommandsFromDir,
  loadPromptCommands,
  bundledPromptCommandDirs,
  defaultPromptCommandDirs,
  expandPromptCommand,
} from "./prompt-files.js"

const tmpDirs: string[] = []
const mkTmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tray-prompt-"))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("parsePromptFile", () => {
  it("reads description and argument-hint from front-matter and strips it from the body", () => {
    const parsed = parsePromptFile(
      "---\ndescription: Deploy the app\nargument-hint: <env>\n---\nDeploy $1 to production.\n",
    )
    expect(parsed?.description).toBe("Deploy the app")
    expect(parsed?.argumentHint).toBe("<env>")
    expect(parsed?.body).toBe("Deploy $1 to production.")
  })

  it("falls back to the first heading as description when there is no front-matter", () => {
    const parsed = parsePromptFile("## Review this diff\n\nLook for bugs in: $ARGUMENTS\n")
    expect(parsed?.description).toBe("Review this diff")
    expect(parsed?.body).toContain("Look for bugs in: $ARGUMENTS")
    expect(parsed?.body).toContain("## Review this diff") // body keeps the heading
  })

  it("falls back to the first non-empty line without heading or front-matter", () => {
    const parsed = parsePromptFile("\nWrite unit tests for the thing\nCover edge cases.\n")
    expect(parsed?.description).toBe("Write unit tests for the thing")
    expect(parsed?.body).toContain("Cover edge cases.")
  })

  it("returns null for an empty file", () => {
    expect(parsePromptFile("")).toBeNull()
    expect(parsePromptFile("   \n \n")).toBeNull()
  })

  it("handles CRLF front-matter", () => {
    const parsed = parsePromptFile("---\r\ndescription: Windows file\r\n---\r\nBody here\r\n")
    expect(parsed?.description).toBe("Windows file")
    expect(parsed?.body).toBe("Body here")
  })
})

describe("expandPromptCommand", () => {
  it("substitutes $ARGUMENTS with the full args string", () => {
    expect(expandPromptCommand("Review $ARGUMENTS now", "src/a.ts src/b.ts")).toBe("Review src/a.ts src/b.ts now")
  })

  it("substitutes positional $1..$9 and blanks the missing ones", () => {
    expect(expandPromptCommand("deploy $2 from $1", "main prod")).toBe("deploy prod from main")
    expect(expandPromptCommand("deploy $5", "main")).toBe("deploy ")
  })

  it("expands to empty when there are no args", () => {
    expect(expandPromptCommand("Review: $ARGUMENTS", "")).toBe("Review: ")
    expect(expandPromptCommand("Review: $ARGUMENTS", "   ")).toBe("Review: ")
  })

  it("keeps a literal dollar via $$", () => {
    expect(expandPromptCommand("cost: $$5 for $1", "item")).toBe("cost: $5 for item")
  })

  it("expands multi-digit positionals ($10 is arg ten, not arg-one-plus-0)", () => {
    const args = "a b c d e f g h i J"
    expect(expandPromptCommand("tenth: $10", args)).toBe("tenth: J")
    expect(expandPromptCommand("ninth: $9", args)).toBe("ninth: i")
    expect(expandPromptCommand("missing: $11", args)).toBe("missing: ")
  })

  it("leaves lowercase $arguments prose alone (placeholder is case-exact)", () => {
    expect(expandPromptCommand("the $arguments are many", "x y")).toBe("the $arguments are many")
  })

  it("survives a real NUL in the body (no sentinel corruption)", () => {
    const nul = String.fromCharCode(0)
    expect(expandPromptCommand("a" + nul + "b $1", "x")).toBe("a" + nul + "b x")
  })
})

describe("loadPromptCommandsFromDir / loadPromptCommands", () => {
  it("loads flat and nested .md files, skipping non-md files and dot/node_modules dirs", () => {
    const dir = mkTmp()
    fs.writeFileSync(path.join(dir, "review.md"), "---\ndescription: Review code\n---\nReview $ARGUMENTS")
    fs.mkdirSync(path.join(dir, "team", "nested"), { recursive: true })
    fs.writeFileSync(path.join(dir, "team", "nested", "ship.md"), "# Ship it\n\nShip $1")
    fs.writeFileSync(path.join(dir, "notes.txt"), "not a command")
    fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true })
    fs.writeFileSync(path.join(dir, "node_modules", "x", "bad.md"), "# Should not load")
    fs.mkdirSync(path.join(dir, ".hidden"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".hidden", "bad.md"), "# Should not load either")

    const cmds = loadPromptCommandsFromDir(dir)
    const names = cmds.map((c) => c.name).sort()
    expect(names).toEqual(["review", "team/nested/ship"])

    const review = cmds.find((c) => c.name === "review")
    expect(review?.description).toBe("Review code")
    expect(review?.file).toBe(path.join(dir, "review.md"))
    expect(loadPromptCommandsFromDir(path.join(dir, "does-not-exist"))).toEqual([])
    expect(loadPromptCommandsFromDir("")).toEqual([])
  })

  it("first directory wins on a name collision (project beats user)", () => {
    const project = mkTmp()
    const user = mkTmp()
    fs.writeFileSync(path.join(project, "hello.md"), "# Project version\n\nproject $ARGUMENTS")
    fs.writeFileSync(path.join(user, "hello.md"), "# User version\n\nuser $ARGUMENTS")

    const both = loadPromptCommands([project, user])
    expect(both).toHaveLength(1)
    expect(both[0]?.body).toContain("project")

    const reversed = loadPromptCommands([user, project])
    expect(reversed[0]?.body).toContain("user")
  })

  it("returns results sorted by name and default dirs in project-first order", () => {
    const dir = mkTmp()
    fs.writeFileSync(path.join(dir, "zeta.md"), "# Z\nz")
    fs.writeFileSync(path.join(dir, "alpha.md"), "# A\na")
    expect(loadPromptCommandsFromDir(dir).map((c) => c.name)).toEqual(["alpha", "zeta"])

    const dirs = defaultPromptCommandDirs("/proj", "/home/u")
    expect(dirs[0]).toBe(path.join("/proj", "commands"))
    expect(dirs[1]).toBe(path.join("/proj", ".nemo", "commands"))
    expect(dirs[2]).toBe(path.join("/home/u", ".nemo", "commands"))
  })

  it("bundled dirs resolve from a module dir and load with lowest precedence", () => {
    // Fake a source checkout: <root>/commands + a module 4 deep, so the
    // startDir seam resolves back to the fake root.
    const root = mkTmp()
    fs.mkdirSync(path.join(root, "commands"), { recursive: true })
    fs.writeFileSync(path.join(root, "commands", "bundled-cmd.md"), "# B\nbundled body")
    const fakeModuleDir = path.join(root, "packages", "tui", "src", "ink-app")
    fs.mkdirSync(fakeModuleDir, { recursive: true })
    const [first, second] = bundledPromptCommandDirs(fakeModuleDir)
    expect(first).toBe(path.join(root, "assets", "commands"))
    expect(second).toBe(path.join(root, "commands"))
    // Project files win over bundled ones on a name collision.
    const project = mkTmp()
    fs.writeFileSync(path.join(project, "bundled-cmd.md"), "# P\nproject body")
    const merged = loadPromptCommands([project, second])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.body).toContain("project")
    // Bundled alone still loads.
    expect(loadPromptCommands([second]).map((c) => c.name)).toContain("bundled-cmd")
  })
})
