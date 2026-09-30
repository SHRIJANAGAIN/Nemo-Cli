/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type * as AgentModule from "./agent.js"

/**
 * discoverAgentProfiles() reads `<cwd>/.trayambak/agents/*.{md,txt,...}` at
 * CALL time plus the bundled assets/agents folder (found via the module's own
 * __dirname). Every test therefore chdirs into a throwaway dir with its own
 * .trayambak, and a temp home is held during the dynamic import so the barrel
 * import chain (llama-cpp-bin etc.) bakes sandboxed paths. The bundled roster
 * is always non-empty, so assertions target the seeded profiles rather than
 * total counts.
 */

let agent: typeof AgentModule
let tmp = ""
let originalCwd = ""
let home = ""
let savedUserprofile: string | undefined
let savedHome: string | undefined

const agentFile = (): string => path.join(tmp, ".trayambak", "agents", "test-reviewer.md")
const txtFile = (): string => path.join(tmp, ".trayambak", "agents", "custom-helper.txt")

function seedReviewer(): string {
  const file = agentFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    "---\nname: Test Reviewer\ndescription: Reviews things for tests\n---\nYou are a test agent.\n",
    "utf8",
  )
  return file
}

function seedPlainTxt(): string {
  const file = txtFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, "Just some plain prompt text.\n", "utf8")
  return file
}

beforeAll(async () => {
  originalCwd = process.cwd()
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-agent-home-"))
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-agent-cwd-"))
  fs.mkdirSync(path.join(tmp, ".trayambak"), { recursive: true })

  savedUserprofile = process.env.USERPROFILE
  savedHome = process.env.HOME
  process.env.USERPROFILE = home
  process.env.HOME = home
  process.chdir(tmp)
  agent = await import("./agent.js")
  process.env.USERPROFILE = savedUserprofile
  process.env.HOME = savedHome
}, 60_000)

afterAll(() => {
  process.chdir(originalCwd)
  for (const dir of [home, tmp]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

beforeEach(() => {
  fs.rmSync(path.join(tmp, ".trayambak"), { recursive: true, force: true })
  fs.mkdirSync(path.join(tmp, ".trayambak"), { recursive: true })
})

describe("agentCommand list", () => {
  it("renders each profile as - id [category] name: description", () => {
    const file = seedReviewer()

    expect(agent.agentCommand({ action: "list" })).toContain(
      `- ${file} [reviewer] Test Reviewer: Reviews things for tests`,
    )
  })

  it("lists a front-matter-less file under its basename", () => {
    const file = seedPlainTxt()

    expect(agent.agentCommand({ action: "list" })).toContain(`- ${file} [specialist] custom-helper: `)
  })
})

describe("agentCommand info", () => {
  it("requires a type", () => {
    expect(agent.agentCommand({ action: "info" })).toBe("Missing agent type")
  })

  it("reports an unknown profile", () => {
    expect(agent.agentCommand({ action: "info", type: "definitely-missing" })).toBe(
      "Agent profile not found: definitely-missing",
    )
  })

  it("resolves by name (case-insensitively) and prints the full block", () => {
    const file = seedReviewer()
    const expected = `Agent: ${file}\nName: Test Reviewer\nCategory: reviewer\nDescription: Reviews things for tests`

    expect(agent.agentCommand({ action: "info", type: "Test Reviewer" })).toBe(expected)
    expect(agent.agentCommand({ action: "info", type: "tEsT rEvIeWeR" })).toBe(expected)
  })

  it("resolves by full profile id (file path)", () => {
    const file = seedReviewer()

    expect(agent.agentCommand({ action: "info", type: file })).toBe(
      `Agent: ${file}\nName: Test Reviewer\nCategory: reviewer\nDescription: Reviews things for tests`,
    )
  })

  it("falls back to filename, empty description and specialist category", () => {
    const file = seedPlainTxt()

    expect(agent.agentCommand({ action: "info", type: "custom-helper" })).toBe(
      `Agent: ${file}\nName: custom-helper\nCategory: specialist\nDescription: `,
    )
  })
})

describe("agentCommand run", () => {
  it("requires both type and prompt", () => {
    expect(agent.agentCommand({ action: "run" })).toBe("Missing type or prompt")
    expect(agent.agentCommand({ action: "run", type: "Test Reviewer" })).toBe("Missing type or prompt")
    expect(agent.agentCommand({ action: "run", prompt: "do it" })).toBe("Missing type or prompt")
  })

  it("reports an unknown profile before queueing", () => {
    expect(agent.agentCommand({ action: "run", type: "definitely-missing", prompt: "do it" })).toBe(
      "Agent profile not found: definitely-missing",
    )
  })

  it("queues a short prompt verbatim", () => {
    seedReviewer()

    expect(agent.agentCommand({ action: "run", type: "Test Reviewer", prompt: "fix the bug" })).toBe(
      "[Agent queued] Test Reviewer will execute: fix the bug",
    )
  })

  it("truncates prompts longer than 200 chars and marks the cut", () => {
    seedReviewer()
    const prompt = "p".repeat(250)

    const out = agent.agentCommand({ action: "run", type: "Test Reviewer", prompt })

    expect(out).toBe("[Agent queued] Test Reviewer will execute: " + "p".repeat(200) + "...")
    expect(out).not.toContain("p".repeat(201))
  })
})

describe("profile helpers", () => {
  it("findProfile matches id or case-insensitive name", () => {
    const file = seedReviewer()

    expect(agent.findProfile("Test Reviewer")?.id).toBe(file)
    expect(agent.findProfile(file)?.name).toBe("Test Reviewer")
    expect(agent.findProfile("nope")).toBeUndefined()
  })

  it("listAgentProfiles summarises id/name/category/description", () => {
    const file = seedReviewer()

    const summary = agent.listAgentProfiles().find((p) => p.id === file)
    expect(summary).toEqual({
      id: file,
      name: "Test Reviewer",
      category: "reviewer",
      description: "Reviews things for tests",
    })
  })

  it("getAgentProfilesRaw exposes the parsed prompt body", () => {
    seedReviewer()

    const raw = agent.getAgentProfilesRaw().find((p) => p.file === agentFile())
    expect(raw?.prompt).toBe("You are a test agent.")
    expect(raw?.source).toBe(".trayambak/agents")
    expect(raw?.category).toBe("reviewer")
  })
})

describe("agentCommand unknown action", () => {
  it("reports the unhandled action name", () => {
    expect(agent.agentCommand({ action: "bogus" as never })).toBe("Unknown agent action: bogus")
  })
})
