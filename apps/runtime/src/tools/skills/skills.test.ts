/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  buildSkillsMentionBlock,
  createSkillTool,
  createSkillTools,
  createSkillToolsFromRoots,
  loadSkillsFromDir,
  parseSkillFile,
  skillToolName,
} from "./skills.js"

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

  it("withholds secret-bearing env from user-authored skill commands", async () => {
    const secretName = "TRAYAMBAK_E2E_SKILL_SECRET"
    const secretValue = "e2e-skill-secret-abcdef"
    const saved = process.env[secretName]
    process.env[secretName] = secretValue
    try {
      const tool = createSkillTool({
        name: "envdump",
        description: "x",
        command: `node -e "process.stdout.write('K=' + process.env.${secretName} + ';P=' + process.env.PATH)"`,
        body: "",
      })
      const res = await tool.execute("1", {}, undefined, undefined, { cwd: dir } as never)
      expect(res.isError).toBe(false)
      const body = res.content.map((c) => c.text).join("\n")
      // Absent vars read as undefined in the child: the secret never arrived.
      expect(body).toContain("K=undefined")
      expect(body).not.toContain(secretValue)
      expect(body).toMatch(/;P=.+/)
    } finally {
      if (saved === undefined) delete process.env[secretName]
      else process.env[secretName] = saved
    }
  })
})

describe("skill tool names (round 11 attack: provider-safe ids)", () => {
  it("sanitizes display names into ids providers accept", () => {
    // "skill__My Skill" (space) would400 EVERY model request; custom tools
    // already sanitize, skills did not.
    expect(skillToolName("My Skill")).toBe("skill__My_Skill")
    expect(skillToolName("git-flow")).toBe("skill__git-flow")
    // Provider cap is 64 chars INCLUDING the prefix (skill__ + 64 overflowed).
    expect(skillToolName("x".repeat(100))).toMatch(/^skill__[A-Za-z0-9_-]{1,57}$/)
    // Non-ASCII collapses to the safe alphabet, still a valid id.
    expect(skillToolName("कौशल")).toMatch(/^skill__[A-Za-z0-9_-]+$/)
  })

  it("registers exactly one tool when two display names collide after sanitizing", () => {
    const descOnly = "---\ndescription: Dir-named skill.\n---\nBody."
    writeSkill("My Skill", "SKILL.md", descOnly)
    writeSkill("My_Skill", "SKILL.md", descOnly)
    const skills = loadSkillsFromDir(dir)
    expect(skills).toHaveLength(2) // distinct display names both load

    const tools = createSkillTools(dir)
    // A duplicate tool name in one request is a provider 400 — first wins.
    expect(tools.map((t) => t.definition.name)).toEqual(["skill__My_Skill"])
  })

  it("command skills get sanitized ids too", () => {
    const tool = createSkillTool({ name: "My Skill", description: "d", command: "echo hi", body: "" })
    expect(tool.definition.name).toBe("skill__My_Skill")
  })

  it("the mention hint lists the ids the model can actually call", () => {
    const tools = buildSkillsMentionBlock([{ name: "My Skill", description: "d", command: "", body: "" }])
    expect(tools).toContain("skill__My_Skill")
    expect(tools).not.toContain("My Skill")
  })

  it("multi-root: first root wins a tool-name collision (user beats bundled)", () => {
    const descOnly = "---\ndescription: Dir-named skill.\n---\nBody."
    const primary = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-skills-primary-"))
    const bundled = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-skills-bundled-"))
    try {
      const mk = (root: string, rel: string): void => {
        const d = path.join(root, rel)
        fs.mkdirSync(d, { recursive: true })
        fs.writeFileSync(path.join(d, "SKILL.md"), descOnly)
      }
      mk(primary, "shared-skill")
      mk(primary, "primary-only")
      mk(bundled, "shared-skill")
      mk(bundled, "bundled-only")
      const tools = createSkillToolsFromRoots([primary, bundled])
      const names = tools.map((t) => t.definition.name).sort()
      expect(names).toEqual(["skill__bundled-only", "skill__primary-only", "skill__shared-skill"])
      // Same single-root behaviour preserved through the multi-root path.
      expect(createSkillToolsFromRoots([bundled]).map((t) => t.definition.name).sort()).toEqual([
        "skill__bundled-only",
        "skill__shared-skill",
      ])
    } finally {
      fs.rmSync(primary, { recursive: true, force: true })
      fs.rmSync(bundled, { recursive: true, force: true })
    }
  })
})
