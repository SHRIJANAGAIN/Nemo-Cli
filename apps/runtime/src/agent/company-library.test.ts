/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  COMPANY_DIR_ENV,
  COMPANY_DISABLED_ENV,
  COMPANY_ENABLED_ENV,
  buildCompanyBlock,
  companyAgentDirs,
  companyModelForProfile,
  companyDisabledFromEnv,
  companyEnabledFromEnv,
  findCompanyAgent,
  listCompanyAgents,
  listCompanyDivisions,
  parseCompanyAgentFile,
  resolveCompanyRoot,
  resolveCompanyState,
} from "./company-library.js"

let root: string
let home: string
let cwd: string
const savedEnv = process.env[COMPANY_DIR_ENV]

function mkdir(p: string): string {
  fs.mkdirSync(p, { recursive: true })
  return p
}

function write(p: string, content: string): string {
  mkdir(path.dirname(p))
  fs.writeFileSync(p, content, "utf8")
  return p
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-company-"))
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-company-home-"))
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-company-cwd-"))
  delete process.env[COMPANY_DIR_ENV]
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env[COMPANY_DIR_ENV]
  else process.env[COMPANY_DIR_ENV] = savedEnv
  for (const dir of [root, home, cwd]) fs.rmSync(dir, { recursive: true, force: true })
})

const AGENT = `---\nname: Code Reviewer\ndescription: Reviews code like a mentor.\n---\n\n# Code Reviewer\nBody.\n`

describe("resolveCompanyRoot", () => {
  it("prefers an explicit root over every default", () => {
    mkdir(path.join(root, "engineering"))
    process.env[COMPANY_DIR_ENV] = path.join(home, "agency-agents-main")
    mkdir(process.env[COMPANY_DIR_ENV])
    expect(resolveCompanyRoot(root, cwd, home)).toBe(root)
  })

  it("falls back to TRAYAMBAK_COMPANY_DIR, then home, then cwd", () => {
    const fromEnv = mkdir(path.join(root, "from-env"))
    const fromHome = mkdir(path.join(home, "agency-agents-main"))
    const fromCwd = mkdir(path.join(cwd, "agency-agents-main"))
    process.env[COMPANY_DIR_ENV] = fromEnv
    expect(resolveCompanyRoot(undefined, cwd, home)).toBe(fromEnv)
    delete process.env[COMPANY_DIR_ENV]
    process.env[COMPANY_DIR_ENV] = path.join(root, "does-not-exist")
    expect(resolveCompanyRoot(undefined, cwd, home)).toBe(fromHome)
    fs.rmSync(fromHome, { recursive: true, force: true })
    expect(resolveCompanyRoot(undefined, cwd, home)).toBe(fromCwd)
  })

  it("returns null when nothing exists and never throws", () => {
    process.env[COMPANY_DIR_ENV] = path.join(root, "does-not-exist")
    expect(resolveCompanyRoot(undefined, cwd, home)).toBeNull()
    expect(resolveCompanyRoot(path.join(root, "missing-too"), cwd, home)).toBeNull()
  })
})

describe("listCompanyDivisions", () => {
  it("reads labels from divisions.json and drops stale entries", () => {
    mkdir(path.join(root, "engineering"))
    write(
      path.join(root, "divisions.json"),
      JSON.stringify({ divisions: { engineering: { label: "Engineering" }, ghost: { label: "Ghost" } } }),
    )
    expect(listCompanyDivisions(root)).toEqual([{ id: "engineering", label: "Engineering" }])
  })

  it("falls back to a directory scan minus non-division dirs", () => {
    mkdir(path.join(root, "engineering"))
    mkdir(path.join(root, "marketing"))
    mkdir(path.join(root, "integrations"))
    mkdir(path.join(root, "strategy"))
    mkdir(path.join(root, ".hidden"))
    write(path.join(root, "divisions.json"), "not json{")
    expect(listCompanyDivisions(root)).toEqual([
      { id: "engineering", label: "engineering" },
      { id: "marketing", label: "marketing" },
    ])
  })

  it("returns [] for a missing root", () => {
    expect(listCompanyDivisions(null)).toEqual([])
    expect(listCompanyDivisions(path.join(root, "missing"))).toEqual([])
  })
})

describe("listCompanyAgents / findCompanyAgent", () => {
  beforeEach(() => {
    mkdir(path.join(root, "engineering"))
    mkdir(path.join(root, "marketing"))
    write(path.join(root, "engineering", "engineering-code-reviewer.md"), AGENT)
    write(path.join(root, "engineering", "notes.txt"), "not an agent")
    write(path.join(root, "marketing", "marketing-seo.md"), AGENT.replace("Code Reviewer", "Seo Pro"))
  })

  it("scans flat files plus one nested level, .md only", () => {
    write(path.join(root, "marketing", "nested", "marketing-deep.md"), AGENT.replace("Code Reviewer", "Deep Agent"))
    const agents = listCompanyAgents(root)
    expect(agents.map((a) => a.slug).sort()).toEqual([
      "engineering-code-reviewer",
      "marketing-deep",
      "marketing-seo",
    ])
    const nested = agents.find((a) => a.slug === "marketing-deep")
    expect(nested?.division).toBe("marketing")
  })

  it("scopes to one division when asked, unknown division gives []", () => {
    expect(listCompanyAgents(root, "engineering").map((a) => a.slug)).toEqual(["engineering-code-reviewer"])
    expect(listCompanyAgents(root, "nope")).toEqual([])
  })

  it("matches by name, slug, and division/slug, case-insensitively", () => {
    expect(findCompanyAgent(root, "Code Reviewer")?.slug).toBe("engineering-code-reviewer")
    expect(findCompanyAgent(root, "ENGINEERING-CODE-REVIEWER")?.division).toBe("engineering")
    expect(findCompanyAgent(root, "marketing/marketing-seo")?.name).toBe("Seo Pro")
    expect(findCompanyAgent(root, "marketing/seo")?.name).toBe("Seo Pro")
    expect(findCompanyAgent(root, "nobody here")).toBeUndefined()
    expect(findCompanyAgent(null, "Code Reviewer")).toBeUndefined()
  })

  it("parse falls back to slug + heading without frontmatter", () => {
    const file = write(path.join(root, "engineering", "bare.md"), "# Bare Agent\nDo things.\n")
    expect(parseCompanyAgentFile(file, "engineering")).toMatchObject({ name: "bare", division: "engineering" })
    expect(parseCompanyAgentFile(path.join(root, "engineering", "missing.md"), "engineering")).toBeNull()
  })
})

describe("buildCompanyBlock (model self-use)", () => {
  beforeEach(() => {
    mkdir(path.join(root, "engineering"))
    mkdir(path.join(root, "marketing"))
    write(path.join(root, "engineering", "engineering-code-reviewer.md"), AGENT)
    write(path.join(root, "marketing", "marketing-seo.md"), AGENT.replace("Code Reviewer", "Seo Pro"))
  })

  it("returns '' with no library or when the master switch is off", () => {
    // home seam: the real ~/agency-agents-main must not rescue the lookup.
    expect(buildCompanyBlock(cwd, null, home)).toBe("")
    expect(buildCompanyBlock(cwd, { companyDir: path.join(root, "missing") }, home)).toBe("")
    expect(buildCompanyBlock(cwd, { companyDir: root, companyEnabled: false }, home)).toBe("")
  })

  it("names departments with counts and teaches self-spawning", () => {
    const block = buildCompanyBlock(cwd, { companyDir: root }, home)
    expect(block).toContain("## COMPANY")
    expect(block).toContain("engineering (1)")
    expect(block).toContain("marketing (1)")
    expect(block).toContain("trayambak__Agent")
    expect(block).toContain("subagent_type")
    expect(block).toContain("slash commands are user-only")
    expect(block.length).toBeLessThan(2000)
  })

  it("hides disabled departments from the model", () => {
    const block = buildCompanyBlock(cwd, { companyDir: root, companyDisabled: ["marketing"] }, home)
    expect(block).toContain("engineering (1)")
    expect(block).not.toContain("marketing")
  })

  it("mentions the company model only when one is set", () => {
    expect(buildCompanyBlock(cwd, { companyDir: root }, home)).not.toContain("Company runs use model")
    const block = buildCompanyBlock(cwd, { companyDir: root, companyModel: "worker-model" }, home)
    expect(block).toContain("Company runs use model `worker-model`")
  })
})

describe("companyModelForProfile (separate model for company runs)", () => {
  it("applies only to company personas and only when different from the session model", () => {
    expect(companyModelForProfile("company/engineering", { companyModel: "worker" }, "main")).toBe("worker")
    // Non-company profiles never match, even with a model configured.
    expect(companyModelForProfile("bundled", { companyModel: "worker" }, "main")).toBeUndefined()
    expect(companyModelForProfile(undefined, { companyModel: "worker" }, "main")).toBeUndefined()
    // Unset, blank, or same-as-session = one model does everything.
    expect(companyModelForProfile("company/engineering", {}, "main")).toBeUndefined()
    expect(companyModelForProfile("company/engineering", null, "main")).toBeUndefined()
    expect(companyModelForProfile("company/engineering", { companyModel: "   " }, "main")).toBeUndefined()
    expect(companyModelForProfile("company/engineering", { companyModel: "main" }, "main")).toBeUndefined()
  })
})

describe("companyAgentDirs", () => {
  it("returns existing division dirs for discovery wiring", () => {
    const eng = mkdir(path.join(root, "engineering"))
    mkdir(path.join(root, "marketing"))
    write(
      path.join(root, "divisions.json"),
      JSON.stringify({ divisions: { engineering: { label: "E" }, marketing: { label: "M" } } }),
    )
    expect(companyAgentDirs(root)).toEqual([eng, path.join(root, "marketing")])
    expect(companyAgentDirs(null)).toEqual([])
  })

  it("leaves disabled divisions out", () => {
    mkdir(path.join(root, "engineering"))
    mkdir(path.join(root, "marketing"))
    expect(companyAgentDirs(root, ["marketing"]).map((d) => path.basename(d))).toEqual(["engineering"])
  })
})

describe("on/off state", () => {
  it("parses the env switches", () => {
    expect(companyDisabledFromEnv({})).toEqual([])
    expect(companyDisabledFromEnv({ [COMPANY_DISABLED_ENV]: "a, b ,,c " })).toEqual(["a", "b", "c"])
    expect(companyEnabledFromEnv({})).toBeUndefined()
    expect(companyEnabledFromEnv({ [COMPANY_ENABLED_ENV]: "0" })).toBe(false)
    expect(companyEnabledFromEnv({ [COMPANY_ENABLED_ENV]: "OFF" })).toBe(false)
    expect(companyEnabledFromEnv({ [COMPANY_ENABLED_ENV]: "1" })).toBe(true)
  })

  it("resolveCompanyState layers config over env over defaults", () => {
    mkdir(path.join(root, "engineering"))
    const env = { [COMPANY_DIR_ENV]: root, [COMPANY_DISABLED_ENV]: "engineering" } as NodeJS.ProcessEnv
    const fromEnv = resolveCompanyState(undefined, cwd, home, null, env)
    expect(fromEnv).toMatchObject({ root, enabled: true, disabled: ["engineering"] })
    // Explicit config wins: master off + own disabled list.
    const fromConfig = resolveCompanyState(undefined, cwd, home, { companyEnabled: false, companyDisabled: ["x"] }, env)
    expect(fromConfig).toMatchObject({ root, enabled: false, disabled: ["x"] })
    expect(resolveCompanyState(undefined, cwd, home, null, {})).toBeNull()
  })

  it("disabled divisions vanish from divisions, agents, and find", () => {
    mkdir(path.join(root, "engineering"))
    mkdir(path.join(root, "marketing"))
    write(path.join(root, "engineering", "engineering-code-reviewer.md"), AGENT)
    write(path.join(root, "marketing", "marketing-seo.md"), AGENT.replace("Code Reviewer", "Seo Pro"))
    expect(listCompanyDivisions(root, ["marketing"]).map((d) => d.id)).toEqual(["engineering"])
    expect(listCompanyAgents(root, undefined, ["marketing"]).map((a) => a.slug)).toEqual([
      "engineering-code-reviewer",
    ])
    expect(listCompanyAgents(root, "marketing", ["marketing"])).toEqual([])
    expect(findCompanyAgent(root, "Seo Pro", undefined, ["marketing"])).toBeUndefined()
    expect(findCompanyAgent(root, "Seo Pro")?.division).toBe("marketing")
  })
})
