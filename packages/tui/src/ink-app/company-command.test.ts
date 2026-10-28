/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { NemoConfig } from "../../../../apps/runtime/src/config.js"
import { handleCompanySlash, type CompanySlashDeps } from "./company-command.js"

let root: string
let emptyHome: string
const savedUserProfile = process.env.USERPROFILE
const savedHomeEnv = process.env.HOME
const savedCompanyDir = process.env.NEMO_COMPANY_DIR
const savedConfigEnv = process.env.NEMO_CONFIG

function deps(args: string, overrides: Partial<CompanySlashDeps> = {}): CompanySlashDeps & {
  messages: string[]
  launches: Array<{ type: string; prompt: string; background: boolean }>
  manyLaunches: Array<{ items: Array<{ type: string; prompt: string }>; background: boolean }>
  agentConfigRef: { current: NemoConfig | null }
  agentRef: { current: unknown }
} {
  const messages: string[] = []
  const launches: Array<{ type: string; prompt: string; background: boolean }> = []
  const manyLaunches: Array<{ items: Array<{ type: string; prompt: string }>; background: boolean }> = []
  return {
    args,
    companyDir: root,
    cwd: root,
    homeDir: emptyHome,
    addSystemMessage: (content: string) => {
      messages.push(content)
      return content
    },
    launchSubagent: (type: string, prompt: string, background: boolean) => {
      launches.push({ type, prompt, background })
    },
    launchMany: (items: Array<{ type: string; prompt: string }>, background: boolean) => {
      manyLaunches.push({ items, background })
    },
    agentConfigRef: { current: null },
    agentRef: { current: null },
    bootConfig: null,
    messages,
    launches,
    manyLaunches,
    ...overrides,
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-company-tui-"))
  emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-company-tui-home-"))
  // Persistence (saveConfig/loadConfig) prefers <cwd>/.nemo when one
  // exists (the checkout has one) — pin NEMO_CONFIG at a temp file.
  process.env.NEMO_CONFIG = path.join(emptyHome, "config.json")
  process.env.USERPROFILE = emptyHome
  process.env.HOME = emptyHome
  delete process.env.NEMO_COMPANY_DIR
  const eng = path.join(root, "engineering")
  fs.mkdirSync(eng, { recursive: true })
  fs.writeFileSync(
    path.join(root, "divisions.json"),
    JSON.stringify({ divisions: { engineering: { label: "Engineering" } } }),
  )
  fs.writeFileSync(
    path.join(eng, "engineering-code-reviewer.md"),
    "---\nname: Code Reviewer\ndescription: Reviews code like a mentor.\n---\n\n# Code Reviewer\n",
  )
})

afterEach(() => {
  if (savedUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = savedUserProfile
  if (savedHomeEnv === undefined) delete process.env.HOME
  else process.env.HOME = savedHomeEnv
  if (savedCompanyDir === undefined) delete process.env.NEMO_COMPANY_DIR
  else process.env.NEMO_COMPANY_DIR = savedCompanyDir
  if (savedConfigEnv === undefined) delete process.env.NEMO_CONFIG
  else process.env.NEMO_CONFIG = savedConfigEnv
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(emptyHome, { recursive: true, force: true })
})

describe("handleCompanySlash", () => {
  it("bare lists departments with counts", () => {
    const d = deps("")
    handleCompanySlash(d)
    expect(d.messages).toHaveLength(1)
    expect(d.messages[0]).toContain("1 departments, 1 agents")
    expect(d.messages[0]).toContain("engineering — Engineering")
  })

  it("list/info browse, run launches with the longest-prefix split", () => {
    const l = deps("list engineering")
    handleCompanySlash(l)
    expect(l.messages[0]).toContain("Code Reviewer")

    const i = deps("info code reviewer")
    handleCompanySlash(i)
    expect(i.messages[0]).toContain("Division: engineering")

    const r = deps("run Code Reviewer audit auth.ts")
    handleCompanySlash(r)
    expect(r.launches).toEqual([{ type: "Code Reviewer", prompt: "audit auth.ts", background: false }])

    const bg = deps("run --bg Code Reviewer audit auth.ts")
    handleCompanySlash(bg)
    expect(bg.launches[0]?.background).toBe(true)
  })

  it("unknown verbs/agents get usage, never a launch", () => {
    const u = deps("frobnicate")
    handleCompanySlash(u)
    expect(u.messages[0]).toContain("Usage: /company")
    expect(u.launches).toEqual([])

    const m = deps("run ghost do things")
    handleCompanySlash(m)
    expect(m.messages[0]).toContain("Usage: /company run")
    expect(m.launches).toEqual([])
  })

  it("missing library reports where to point, without launching", () => {
    const saved = process.env.NEMO_COMPANY_DIR
    delete process.env.NEMO_COMPANY_DIR
    try {
      const d = deps("", { companyDir: path.join(root, "missing"), cwd: emptyHome, homeDir: emptyHome })
      handleCompanySlash(d)
      expect(d.messages[0]).toContain("Company library not found")
      expect(d.launches).toEqual([])
    } finally {
      if (saved === undefined) delete process.env.NEMO_COMPANY_DIR
      else process.env.NEMO_COMPANY_DIR = saved
    }
  })

  it("off gates list/info/run, on restores, and both persist + rebuild", () => {
    const d = deps("off")
    handleCompanySlash(d)
    expect(d.messages[0]).toContain("Company OFF")
    expect(d.agentRef.current).toBeNull()

    const l = deps("list", { agentConfigRef: d.agentConfigRef, agentRef: d.agentRef })
    handleCompanySlash(l)
    expect(l.messages[0]).toContain("Company is OFF")
    expect(l.launches).toEqual([])

    const r = deps("run Code Reviewer audit x", { agentConfigRef: d.agentConfigRef, agentRef: d.agentRef })
    handleCompanySlash(r)
    expect(r.messages[0]).toContain("Company is OFF")
    expect(r.launches).toEqual([])

    // Persistence is real: a fresh deps object (fresh loadConfig) still sees OFF.
    const l2 = deps("list")
    handleCompanySlash(l2)
    expect(l2.messages[0]).toContain("Company is OFF")

    const on = deps("on")
    handleCompanySlash(on)
    expect(on.messages[0]).toContain("Company ON")
    const l3 = deps("list engineering")
    handleCompanySlash(l3)
    expect(l3.messages[0]).toContain("Code Reviewer")
  })

  it("disable/enable toggles one department", () => {
    const d = deps("disable engineering")
    handleCompanySlash(d)
    expect(d.messages[0]).toContain("engineering disabled")

    const l = deps("list engineering")
    handleCompanySlash(l)
    expect(l.messages[0]).toContain("disabled division: engineering")

    const bare = deps("")
    handleCompanySlash(bare)
    expect(bare.messages[0]).toContain("engineering — Engineering (OFF)")

    const e = deps("enable engineering")
    handleCompanySlash(e)
    expect(e.messages[0]).toContain("engineering enabled.")
    const l2 = deps("list engineering")
    handleCompanySlash(l2)
    expect(l2.messages[0]).toContain("Code Reviewer")
  })

  it("status reports master, off list, model, and root", () => {
    const s = deps("status")
    handleCompanySlash(s)
    expect(s.messages[0]).toContain("Company: ON")
    expect(s.messages[0]).toContain("disabled departments: none")
    expect(s.messages[0]).toContain("model: session default (one model for everything)")
    expect(s.messages[0]).toContain(root)
  })

  it("run all launches every enabled agent in one foreground batch", () => {
    const mkt = path.join(root, "marketing")
    fs.mkdirSync(mkt, { recursive: true })
    fs.writeFileSync(
      path.join(mkt, "marketing-seo.md"),
      "---\nname: Seo Pro\ndescription: Ranks pages.\n---\n\n# Seo Pro\n",
    )
    fs.writeFileSync(
      path.join(root, "divisions.json"),
      JSON.stringify({ divisions: { engineering: { label: "Engineering" }, marketing: { label: "Marketing" } } }),
    )
    const d = deps("run all audit everything")
    handleCompanySlash(d)
    expect(d.messages[0]).toContain("Launching 2 company agents (whole company) in bounded foreground batches")
    expect(d.manyLaunches).toHaveLength(1)
    expect(d.manyLaunches[0]?.background).toBe(false)
    expect(d.manyLaunches[0]?.items.map((i) => i.type).sort()).toEqual(["Code Reviewer", "Seo Pro"])
    expect(d.launches).toEqual([])
  })

  it("run <division> launches just that department", () => {
    const d = deps("run engineering audit code")
    handleCompanySlash(d)
    expect(d.manyLaunches).toHaveLength(1)
    expect(d.manyLaunches[0]?.items).toEqual([{ type: "Code Reviewer", prompt: "audit code" }])
    expect(d.launches).toEqual([])
  })

  it("run all without a prompt shows usage, never launches", () => {
    const d = deps("run all")
    handleCompanySlash(d)
    expect(d.messages[0]).toContain("Usage: /company run <division|all> <prompt>")
    expect(d.manyLaunches).toEqual([])
    expect(d.launches).toEqual([])
  })
})
