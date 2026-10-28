/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { COMPANY_DIR_ENV } from "../../../runtime/src/agent/company-library.js"
import { companyCommand, splitCompanyRunArgs } from "./company.js"

let root: string
let fakeHome: string
const savedEnv = process.env[COMPANY_DIR_ENV]
const savedUserProfile = process.env.USERPROFILE
const savedHomeEnv = process.env.HOME
const savedConfigEnv = process.env.NEMO_CONFIG

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-company-cmd-"))
  // saveConfig/loadConfig prefer <cwd>/.nemo when present (the repo
  // checkout has one) — pin NEMO_CONFIG at a temp file so on/off
  // tests can never touch the real config.
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-company-cmd-home-"))
  process.env.NEMO_CONFIG = path.join(fakeHome, "config.json")
  process.env.USERPROFILE = fakeHome
  process.env.HOME = fakeHome
  const eng = path.join(root, "engineering")
  const mkt = path.join(root, "marketing")
  fs.mkdirSync(eng, { recursive: true })
  fs.mkdirSync(mkt, { recursive: true })
  fs.writeFileSync(
    path.join(root, "divisions.json"),
    JSON.stringify({ divisions: { engineering: { label: "Engineering" }, marketing: { label: "Marketing" } } }),
  )
  fs.writeFileSync(
    path.join(eng, "engineering-code-reviewer.md"),
    "---\nname: Code Reviewer\ndescription: Reviews code like a mentor.\n---\n\n# Code Reviewer\n",
  )
  fs.writeFileSync(
    path.join(mkt, "marketing-seo.md"),
    "---\nname: Seo Pro\ndescription: Ranks pages.\n---\n\n# Seo Pro\n",
  )
  process.env[COMPANY_DIR_ENV] = root
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env[COMPANY_DIR_ENV]
  else process.env[COMPANY_DIR_ENV] = savedEnv
  if (savedUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = savedUserProfile
  if (savedHomeEnv === undefined) delete process.env.HOME
  else process.env.HOME = savedHomeEnv
  if (savedConfigEnv === undefined) delete process.env.NEMO_CONFIG
  else process.env.NEMO_CONFIG = savedConfigEnv
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(fakeHome, { recursive: true, force: true })
})

describe("companyCommand", () => {
  it("divisions lists departments with counts and usage", () => {
    const out = companyCommand({ action: "divisions" })
    expect(out).toContain("2 departments, 2 agents")
    expect(out).toContain("engineering — Engineering (1 agents)")
    expect(out).toContain("/company run <agent> <prompt>")
  })

  it("list scopes to a division and rejects unknown ones", () => {
    expect(companyCommand({ action: "list", division: "engineering" })).toContain("Code Reviewer")
    const bad = companyCommand({ action: "list", division: "nope" })
    expect(bad).toContain("Unknown, empty, or disabled division: nope")
    expect(bad).toContain("engineering, marketing")
  })

  it("list without a division groups by department", () => {
    const out = companyCommand({ action: "list" })
    expect(out).toContain("## Engineering (1)")
    expect(out).toContain("## Marketing (1)")
  })

  it("info resolves by name and reports misses", () => {
    const out = companyCommand({ action: "info", type: "code reviewer" })
    expect(out).toContain("Company agent: Code Reviewer")
    expect(out).toContain("Division: engineering")
    expect(companyCommand({ action: "info", type: "ghost" })).toContain("Company agent not found: ghost")
    expect(companyCommand({ action: "info" })).toContain("Usage: /company info <agent>")
  })

  it("run queues a resolved agent and rejects misses/empties", () => {
    const out = companyCommand({ action: "run", type: "seo pro", prompt: "rank my page" })
    expect(out).toContain("[Company queued] Seo Pro [marketing] will execute: rank my page")
    expect(companyCommand({ action: "run", type: "ghost", prompt: "x" })).toContain("Company agent not found")
    expect(companyCommand({ action: "run", type: "seo pro" })).toContain("Usage: /company run <agent|division|all>")
  })

  it("run all / run <division> queues the whole (sub)roster", () => {
    const all = companyCommand({ action: "run", type: "all", prompt: "audit everything" })
    expect(all).toContain("[Company queued] 2 agents (engineering, marketing) will execute: audit everything")
    const div = companyCommand({ action: "run", type: "marketing", prompt: "rank it" })
    expect(div).toContain("[Company queued] 1 agents (marketing) will execute: rank it")
  })

  it("splitCompanyRunArgs matches the longest persona-name prefix", () => {
    expect(splitCompanyRunArgs(root, ["Code", "Reviewer", "audit", "x"])).toEqual({
      type: "Code Reviewer",
      prompt: "audit x",
    })
    expect(splitCompanyRunArgs(root, ["marketing-seo", "rank", "it"])).toEqual({ type: "Seo Pro", prompt: "rank it" })
    expect(splitCompanyRunArgs(root, ["ghost", "do", "things"])).toBeNull()
    expect(splitCompanyRunArgs(root, ["Code", "Reviewer"])).toBeNull()
  })

  it("reports a missing library with where it looked", () => {
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-company-empty-home-"))
    try {
      process.env[COMPANY_DIR_ENV] = path.join(root, "does-not-exist")
      const out = companyCommand({ action: "divisions", root: path.join(root, "missing"), homeDir: emptyHome })
      expect(out).toContain("Company library not found")
      expect(out).toContain(COMPANY_DIR_ENV)
    } finally {
      fs.rmSync(emptyHome, { recursive: true, force: true })
    }
  })

  it("on/off flips the master switch and gates list/info/run", () => {
    expect(companyCommand({ action: "off" })).toContain("Company OFF")
    expect(companyCommand({ action: "list" })).toContain("Company is OFF")
    expect(companyCommand({ action: "info", type: "Code Reviewer" })).toContain("Company is OFF")
    expect(companyCommand({ action: "run", type: "Code Reviewer", prompt: "x" })).toContain("Company is OFF")
    // Browsing still works while off, marked as such.
    expect(companyCommand({ action: "divisions" })).toContain("master OFF")
    expect(companyCommand({ action: "on" })).toContain("Company ON")
    expect(companyCommand({ action: "list", division: "engineering" })).toContain("Code Reviewer")
  })

  it("disable/enable toggles one department and persists", () => {
    expect(companyCommand({ action: "disable", division: "marketing" })).toBe(
      "marketing disabled — its agents no longer list or run.",
    )
    expect(companyCommand({ action: "list", division: "marketing" })).toContain("disabled division: marketing")
    expect(companyCommand({ action: "info", type: "Seo Pro" })).toContain("Company agent not found: Seo Pro")
    expect(companyCommand({ action: "divisions" })).toContain("marketing — Marketing (OFF)")
    // Engineering is untouched.
    expect(companyCommand({ action: "list", division: "engineering" })).toContain("Code Reviewer")
    expect(companyCommand({ action: "enable", division: "marketing" })).toBe("marketing enabled.")
    expect(companyCommand({ action: "list", division: "marketing" })).toContain("Seo Pro")
  })

  it("disable rejects unknown divisions and needs a name", () => {
    expect(companyCommand({ action: "disable", division: "nope" })).toContain("Unknown division: nope")
    expect(companyCommand({ action: "disable" })).toContain("Usage: /company disable <division>")
  })

  it("status reports master, off list, model, and root", () => {
    const out = companyCommand({ action: "status" })
    expect(out).toContain("Company: ON")
    expect(out).toContain("disabled departments: none")
    expect(out).toContain("model: session default (one model for everything)")
    expect(out).toContain(root)
  })
})
