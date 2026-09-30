/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createSkillTool, loadSkillsFromDir, parseSkillFile } from "./skills.js"

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-skills-"))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function writeSkill(relDir: string, file: string, body: string): string {
  const d = path.join(dir, relDir)
  fs.mkdirSync(d, { recursive: true })
  const f = path.join(d, file)
  fs.writeFileSync(f, body)
  return f
}

const GUIDE = `---
name: git-flow
description: Branch workflow guide.
---
# Git flow
Always rebase.
`

describe("loadSkillsFromDir", () => {
  it("matches SKILL.md only (README/CHANGELOG never become tools)", () => {
    writeSkill("a", "SKILL.md", GUIDE)
    writeSkill("a", "README.md", GUIDE)
    writeSkill("a", "CHANGELOG.md", GUIDE)
    const skills = loadSkillsFromDir(dir)
    expect(skills.map((s) => s.name)).toEqual(["git-flow"])
  })

  it("falls back to the parent directory name for SKILL.md", () => {
    writeSkill("my-skill", "SKILL.md", `---\ndescription: No name field.\n---\nBody here.`)
    const skills = loadSkillsFromDir(dir)
    expect(skills[0].name).toBe("my-skill")
  })

  it("trims front-matter keys and clamps timeouts", () => {
    const spec = parseSkillFile(`---\nname : spaced\ndescription: d\ntimeout: abc\n---\nBody`, "x.md")
    expect(spec?.name).toBe("spaced")
    expect(spec?.timeout).toBeUndefined()
    const ok = parseSkillFile(`---\nname: t\ndescription: d\ntimeout: 99999\n---\nBody`, "x.md")
    expect(ok?.timeout).toBe(600)
  })

  it("dedupes identical skill names", () => {
    writeSkill("one", "SKILL.md", GUIDE)
    writeSkill("two", "SKILL.md", GUIDE)
    const skills = loadSkillsFromDir(dir)
    expect(skills.map((s) => s.name)).toEqual(["git-flow"])
  })

  it("caps depth and ignores symlink loops", () => {
    let deep = dir
    for (let i = 0; i < 12; i++) {
      deep = path.join(deep, `d${i}`)
      fs.mkdirSync(deep, { recursive: true })
    }
    writeSkill(path.relative(dir, deep), "SKILL.md", GUIDE)
    try {
      fs.symlinkSync(dir, path.join(dir, "loop"), "junction")
    } catch {
      /* non-admin Windows: skip symlink part */
    }
    const skills = loadSkillsFromDir(dir)
    expect(skills).toEqual([])
  })
})

describe("createSkillTool", () => {
  it("returns the body for command-less (Claude-style) skills, never echo", async () => {
    writeSkill("g", "SKILL.md", GUIDE)
    const [spec] = loadSkillsFromDir(dir)
    const tool = createSkillTool(spec)
    expect(tool.definition.name).toBe("skill__git-flow")
    const res = await tool.execute("1", {}, undefined, undefined, { cwd: dir } as never)
    const text = res.content.map((c) => c.text).join("\n")
    expect(text).toContain("Always rebase.")
    expect(text).not.toContain("echo")
  })

  it("rejects cwd escapes outside the workspace", async () => {
    const outside = path.join(path.parse(dir).root, "outside-ws-xyz")
    const tool = createSkillTool({
      name: "evil",
      description: "x",
      command: "node -e 1",
      cwd: outside,
      body: "",
    })
    const proj = path.join(dir, "proj")
    const res = await tool.execute("1", {}, undefined, undefined, { cwd: proj } as never)
    expect(res.isError).toBe(true)
    expect(res.content.map((c) => c.text).join("\n")).toMatch(/unsafe cwd|Access denied/i)
  })
})
