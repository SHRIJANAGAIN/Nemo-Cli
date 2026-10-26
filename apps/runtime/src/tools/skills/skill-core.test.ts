/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { SKILL_MAX_FILES, bundledSkillsDir, walkSkillFiles } from "./skill-core.js"

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-skill-core-"))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function write(rel: string, content = "x"): string {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, "utf8")
  return full
}

describe("walkSkillFiles (round 11 attack: bounded walk)", () => {
  it("never descends into node_modules/.git or dot-directories", () => {
    const kept = write("SKILL.md")
    write("node_modules/pkg/README.md")
    write("node_modules/pkg/docs/deep.md")
    write(".git/notes.md")
    write(".hidden/skill.md")
    write("dist/bundle.md")
    write("venv/pkg.md")

    expect(walkSkillFiles(root)).toEqual([kept])
  })

  it("stops at the depth cap instead of crawling a deep tree (or junction loop) forever", () => {
    const shallow = path.join(root, "a", "b", "c", "file.md")
    fs.mkdirSync(path.dirname(shallow), { recursive: true })
    fs.writeFileSync(shallow, "x", "utf8")
    // 6 levels below root: beyond SKILL_MAX_DEPTH (walk starts at depth 0).
    const deep = path.join(root, "a", "b", "c", "d", "e", "f", "gone.md")
    fs.mkdirSync(path.dirname(deep), { recursive: true })
    fs.writeFileSync(deep, "x", "utf8")

    const files = walkSkillFiles(root)
    expect(files).toContain(shallow)
    expect(files).not.toContain(deep)
  })

  it("caps the collected file count at SKILL_MAX_FILES", () => {
    for (let i = 0; i < SKILL_MAX_FILES + 10; i++) {
      fs.writeFileSync(path.join(root, `f${i}.md`), "x", "utf8")
    }
    expect(walkSkillFiles(root)).toHaveLength(SKILL_MAX_FILES)
  })

  it("skips symlinked directories rather than following them out of the root", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-skill-outside-"))
    try {
      fs.writeFileSync(path.join(outside, "secret.md"), "x", "utf8")
      const kept = write("SKILL.md")
      try {
        fs.symlinkSync(outside, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir")
      } catch {
        /* symlink creation unavailable: the junction part is skipped */
        expect(walkSkillFiles(root)).toEqual([kept])
        return
      }
      expect(walkSkillFiles(root)).toEqual([kept])
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe("bundledSkillsDir (shipped fleet: never cwd-dependent)", () => {
  it("resolves from a module dir via the startDir seam", () => {
    // Fake a source checkout: <root>/skills + a module 5 deep, so the
    // seam resolves back to the fake root.
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-bundled-skills-"))
    try {
      fs.mkdirSync(path.join(fakeRoot, "skills"), { recursive: true })
      const fakeModuleDir = path.join(fakeRoot, "apps", "runtime", "src", "tools", "skills")
      fs.mkdirSync(fakeModuleDir, { recursive: true })
      expect(bundledSkillsDir(fakeModuleDir)).toBe(path.join(fakeRoot, "skills"))
    } finally {
      fs.rmSync(fakeRoot, { recursive: true, force: true })
    }
  })

  it("returns null when no candidate exists (and never throws)", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-bundled-empty-"))
    try {
      expect(bundledSkillsDir(path.join(empty, "a", "b", "c", "d", "e"))).toBeNull()
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })
})
