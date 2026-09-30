/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  defaultCommandsDir,
  defaultRulesDir,
  loadCommandsFromDir,
  loadRulesFromDir,
  parseCommandFile,
  rulesBlock,
} from "./commands.js"

describe("parseCommandFile", () => {
  it("parses frontmatter, body and filename-derived name", () => {
    const raw = "---\ndescription: Deploy the app\nargument-hint: <env>\n---\n\nRun the deploy script.\nWith args.\n"
    const file = path.join("cmds", "deploy.md")
    expect(parseCommandFile(raw, file)).toEqual({
      name: "deploy",
      description: "Deploy the app",
      argumentHint: "<env>",
      body: "Run the deploy script.\nWith args.",
      file,
    })
  })

  it("keeps colons in values and strips wrapping quotes", () => {
    const raw = "---\ndescription: \"Run: staged checks\"\nargument-hint: '<file>'\n---\nbody\n"
    const spec = parseCommandFile(raw, "/x/audit.md")
    expect(spec?.description).toBe("Run: staged checks")
    expect(spec?.argumentHint).toBe("<file>")
    expect(spec?.body).toBe("body")
  })

  it("returns null when there is no frontmatter fence", () => {
    expect(parseCommandFile("just a body\n", "/x/plain.md")).toBeNull()
    expect(parseCommandFile("---\nunclosed\n", "/x/plain.md")).toBeNull()
  })

  it("returns null when the file has no basename", () => {
    expect(parseCommandFile("---\ndescription: x\n---\nbody\n", "")).toBeNull()
  })

  it("defaults description to '' and argumentHint to undefined when absent", () => {
    const spec = parseCommandFile("---\nname: ignored\n---\nDo things\n", "/x/do.md")
    expect(spec).toEqual({
      name: "do",
      description: "",
      argumentHint: undefined,
      body: "Do things",
      file: "/x/do.md",
    })
  })
})

describe("loadCommandsFromDir", () => {
  let dir = ""

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-cmds-"))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("returns [] for an empty or missing directory", () => {
    expect(loadCommandsFromDir("")).toEqual([])
    expect(loadCommandsFromDir(path.join(dir, "nope"))).toEqual([])
  })

  it("loads only valid .md files, skipping non-md, broken and directory entries, sorted by name", () => {
    fs.writeFileSync(path.join(dir, "zebra.md"), "---\ndescription: Z\n---\nZ body\n", "utf8")
    fs.writeFileSync(path.join(dir, "alpha.md"), "---\ndescription: A\n---\nA body\n", "utf8")
    fs.writeFileSync(path.join(dir, "broken.md"), "no frontmatter here\n", "utf8")
    fs.writeFileSync(path.join(dir, "notes.txt"), "---\ndescription: T\n---\nignored\n", "utf8")
    fs.mkdirSync(path.join(dir, "nested.md"))

    const specs = loadCommandsFromDir(dir)
    expect(specs.map((s) => s.name)).toEqual(["alpha", "zebra"])
    expect(specs.map((s) => s.description)).toEqual(["A", "Z"])
    expect(specs[0].file).toBe(path.join(dir, "alpha.md"))
    expect(specs[0].body).toBe("A body")
  })
})

describe("loadRulesFromDir", () => {
  let dir = ""

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-rules-"))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("returns [] for an empty or missing directory", () => {
    expect(loadRulesFromDir("")).toEqual([])
    expect(loadRulesFromDir(path.join(dir, "nope"))).toEqual([])
  })

  it("titles each rule with its filename, trims content and sorts the list", () => {
    fs.writeFileSync(path.join(dir, "security.md"), "\nNever hardcode secrets.\n", "utf8")
    fs.writeFileSync(path.join(dir, "style.md"), "Prefer const.\n", "utf8")
    fs.writeFileSync(path.join(dir, "skip.txt"), "not markdown\n", "utf8")
    fs.mkdirSync(path.join(dir, "sub.md"))

    const rules = loadRulesFromDir(dir)
    expect(rules).toEqual(["### security\nNever hardcode secrets.", "### style\nPrefer const."])
  })
})

describe("rulesBlock", () => {
  it("returns an empty string for no rules", () => {
    expect(rulesBlock([])).toBe("")
  })

  it("prefixes the block with the rules header", () => {
    expect(rulesBlock(["### a\nA", "### b\nB"])).toBe("Rules (from .trayambak/rules):\n### a\nA\n### b\nB")
  })
})

describe("default directories", () => {
  let originalCwd = ""
  let tmp = ""

  beforeEach(() => {
    originalCwd = process.cwd()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-cwd-"))
    process.chdir(tmp)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("resolves the commands dir as <cwd>/commands", () => {
    expect(defaultCommandsDir()).toBe(path.join(tmp, "commands"))
  })

  it("resolves the rules dir as <cwd>/.trayambak/rules", () => {
    expect(defaultRulesDir()).toBe(path.join(tmp, ".trayambak", "rules"))
  })
})
