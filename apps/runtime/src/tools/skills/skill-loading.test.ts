/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { loadSkillRoot } from "./skill-loading.js"

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-skill-load-"))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("loadSkillRoot (round 11 attack)", () => {
  it("derives a nameless SKILL.md from its PARENT DIRECTORY, not the literal file name", () => {
    // Passing basename(file) to parseSkillFile collapsed every nameless
    // SKILL.md to the name "SKILL" (dirname("SKILL.md") === "." defeated
    // the parent-dir fallback the tool walker relies on).
    const skillDir = path.join(root, "my-skill")
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\ndescription: From a dir.\n---\nBody.", "utf8")

    const result = loadSkillRoot(root)
    expect(result.errors).toEqual([])
    expect(result.skills.map((s) => s.name)).toEqual(["my-skill"])
    expect(result.skills[0].pathToSkillsMd).toBe(path.join(skillDir, "SKILL.md"))
  })

  it("still names other markdown files after the file itself", () => {
    fs.writeFileSync(path.join(root, "notes.md"), "---\nname: noted\ndescription: d.\n---\nBody.", "utf8")

    const result = loadSkillRoot(root)
    expect(result.skills.map((s) => s.name)).toEqual(["noted"])
  })

  it("reports a missing directory instead of throwing", () => {
    const result = loadSkillRoot(path.join(root, "nope"))
    expect(result.skills).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toBe("directory not found")
  })
})
