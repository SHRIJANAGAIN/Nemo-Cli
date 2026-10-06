/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { TrayambakConfig } from "../../../runtime/src/index.js"
import { buildTrayambakSlashRegistry, dispatchSlashCommandAsync } from "./command-dispatch.js"

/**
 * plan.ts binds PLAN_DIR from os.homedir() AT MODULE LOAD, and the /plan
 * handler imports it lazily on FIRST dispatch — so the temp home is
 * installed before the first dispatch and restored afterwards (the real
 * ~/.trayambak/plans is never touched). Same isolation as plan.test.ts.
 */

let home = ""
let savedUserprofile: string | undefined
let savedHome: string | undefined

const registry = buildTrayambakSlashRegistry()
const config = {} as TrayambakConfig

const dispatch = (input: string): ReturnType<typeof dispatchSlashCommandAsync> =>
  dispatchSlashCommandAsync(registry, input, config)

const planIdFrom = (out: string): string => {
  const m = /^Created plan (plan-[a-z0-9]+): /.exec(out)
  if (!m) throw new Error(`unexpected create output: ${out}`)
  return m[1]
}

const stepIdFrom = (out: string): string => {
  const m = /^Added step (step-[a-z0-9]+): /.exec(out)
  if (!m) throw new Error(`unexpected add-step output: ${out}`)
  return m[1]
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-dispatch-home-"))
  savedUserprofile = process.env.USERPROFILE
  savedHome = process.env.HOME
  process.env.USERPROFILE = home
  process.env.HOME = home
})

afterAll(() => {
  process.env.USERPROFILE = savedUserprofile
  process.env.HOME = savedHome
  try {
    fs.rmSync(home, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe("/plan slash argument mapping (round 11 attack)", () => {
  it("keeps every word of a multi-word create description", async () => {
    const created = await dispatch("/plan create demo plan about doing the thing")
    expect(created.matched).toBe(true)
    const id = planIdFrom(created.output)

    const shown = await dispatch(`/plan show ${id}`)
    expect(shown.output).toContain("Description: plan about doing the thing")
  })

  it("maps update-step <plan> <step> <status> [description...] without clobbering the description", async () => {
    const created = await dispatch("/plan create steps")
    const id = planIdFrom(created.output)

    const added = await dispatch(`/plan add-step ${id} do the migration`)
    expect(added.output).toMatch(/^Added step step-[a-z0-9]+: do the migration$/)
    const stepId = stepIdFrom(added.output)

    const updated = await dispatch(`/plan update-step ${id} ${stepId} completed now with extra detail`)
    expect(updated.output).toBe(`Updated step ${stepId} -> completed`)

    const shown = await dispatch(`/plan show ${id}`)
    // Description comes from args[4..] — NOT the status word, and nothing
    // after it is dropped. (The old mapping read args[3] twice.)
    expect(shown.output).toContain(`[x] ${stepId}: now with extra detail`)
    expect(shown.output).not.toContain(`${stepId}: completed`)
  })

  it("rejects an unknown status word instead of persisting it", async () => {
    const created = await dispatch("/plan create stat")
    const id = planIdFrom(created.output)
    const added = await dispatch(`/plan add-step ${id} step text`)
    const stepId = stepIdFrom(added.output)

    const updated = await dispatch(`/plan update-step ${id} ${stepId} banana`)
    expect(updated.output).toBe("Invalid status: banana")

    const shown = await dispatch(`/plan show ${id}`)
    expect(shown.output).toContain(`[ ] ${stepId}: step text`)
  })

  it("rejects traversal plan ids as usage errors", async () => {
    const shown = await dispatch("/plan show ../evil")
    expect(shown.matched).toBe(true)
    expect(shown.output).toBe("Invalid plan id: ../evil")
    expect(fs.existsSync(path.join(home, ".trayambak", "evil.json"))).toBe(false)
  })
})

describe("/task slash argument mapping (round 12 attack)", () => {
  const taskIdFrom = (out: string): string => {
    const m = /^(task_[a-z0-9]+_[a-z0-9]+) \| /.exec(out)
    if (!m) throw new Error(`unexpected task list output: ${out}`)
    return m[1]
  }

  it("keeps every word of create content and the task lands in the shared store", async () => {
    await dispatch("/task reset")
    const created = await dispatch("/task create buy the milk")
    expect(created.output).toBe("[Task queued] buy the milk")

    // The queued promise is real: `list` reads the same store back.
    const listed = await dispatch("/task list")
    const id = taskIdFrom(listed.output)
    expect(listed.output).toBe(`${id} | pending | buy the milk`)

    // status is args[2] and now actually reaches taskCommand.
    const updated = await dispatch(`/task update ${id} completed`)
    expect(updated.output).toBe(`Task ${id} updated`)
    expect((await dispatch(`/task get ${id}`)).output).toBe(`${id} | completed | buy the milk`)
  })

  it("rejects an unknown status instead of pretending it was applied", async () => {
    await dispatch("/task reset")
    await dispatch("/task create t")
    const listed = await dispatch("/task list")
    const id = taskIdFrom(listed.output)

    const updated = await dispatch(`/task update ${id} banana`)
    expect(updated.output).toBe("Invalid status: banana")
    expect((await dispatch(`/task get ${id}`)).output).toContain("| pending |")
  })

  it("update without a status says so instead of acknowledging nothing", async () => {
    await dispatch("/task reset")
    await dispatch("/task create t")
    const listed = await dispatch("/task list")
    const id = taskIdFrom(listed.output)

    expect((await dispatch(`/task update ${id}`)).output).toBe("Missing status")
  })
})

describe("/mode, /worktree, /compact forward their arguments (round 12 attack)", () => {
  it("/mode reaches set/current with the mode name (was hard-coded to list)", async () => {
    expect((await dispatch("/mode current")).output).toBe("Current mode: default")
    expect((await dispatch("/mode set code")).output).toBe("Mode set to: code")
    // Round 13: set persists, so current observes it through the slash path.
    expect((await dispatch("/mode current")).output).toBe("Current mode: code")
    expect((await dispatch("/mode set vaporwave")).output).toContain("Unknown mode: vaporwave")
  })

  it("/worktree forwards actions and reports usage without touching git", async () => {
    const savedExitCode = process.exitCode
    process.exitCode = undefined
    try {
      expect((await dispatch("/worktree remove")).output).toBe("Missing path")
      expect((await dispatch("/worktree create")).output).toBe("Missing path or name")
      expect((await dispatch("/worktree switch /definitely/not/a/worktree")).output).toContain("does not exist")
      // Usage errors mark exit 2 (command convention), restored below.
      expect(process.exitCode).toBe(2)
    } finally {
      process.exitCode = savedExitCode
    }
  })

  it("/compact forwards the action (was hard-coded to config)", async () => {
    expect((await dispatch("/compact estimate")).output).toBe("Messages: 0, Tokens: 0\nShould compact: no")
    expect((await dispatch("/compact run")).output).toContain("Compaction result:")
    expect((await dispatch("/compact")).output).toContain("Compaction config:")
  })
})

describe("/company slash argument mapping (company library)", () => {
  it("bare /company shows divisions, list/info/run forward their arguments", async () => {
    const lib = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-dispatch-company-"))
    try {
      const eng = path.join(lib, "engineering")
      fs.mkdirSync(eng, { recursive: true })
      fs.writeFileSync(
        path.join(lib, "divisions.json"),
        JSON.stringify({ divisions: { engineering: { label: "Engineering" } } }),
      )
      fs.writeFileSync(
        path.join(eng, "engineering-code-reviewer.md"),
        "---\nname: Code Reviewer\ndescription: Reviews code like a mentor.\n---\n\n# Code Reviewer\n",
      )
      const savedCompanyDir = process.env.TRAYAMBAK_COMPANY_DIR
      const savedConfig = process.env.TRAYAMBAK_CONFIG
      process.env.TRAYAMBAK_COMPANY_DIR = lib
      // saveConfig/loadConfig prefer <cwd>/.trayambak when one exists —
      // pin a temp file so switch tests never touch the real config.
      process.env.TRAYAMBAK_CONFIG = path.join(lib, "test-config.json")
      try {
        // Bare = divisions (the default action, not list).
        expect((await dispatch("/company")).output).toContain("1 departments, 1 agents")
        expect((await dispatch("/company divisions")).output).toContain("engineering — Engineering")
        // list scopes; info joins multi-word names; run queues with the prompt.
        expect((await dispatch("/company list engineering")).output).toContain("Code Reviewer")
        expect((await dispatch("/company info code reviewer")).output).toContain("Division: engineering")
        expect((await dispatch("/company run code reviewer audit auth.ts")).output).toContain(
          "[Company queued] Code Reviewer [engineering] will execute: audit auth.ts",
        )
        expect((await dispatch("/company run ghost do things")).output).toContain("Company agent not found: ghost")
        expect((await dispatch("/company run all audit everything")).output).toContain("[Company queued] 1 agents")
        expect((await dispatch("/company run engineering audit code")).output).toContain(
          "[Company queued] 1 agents (engineering) will execute: audit code",
        )
      } finally {
        if (savedCompanyDir === undefined) delete process.env.TRAYAMBAK_COMPANY_DIR
        else process.env.TRAYAMBAK_COMPANY_DIR = savedCompanyDir
        if (savedConfig === undefined) delete process.env.TRAYAMBAK_CONFIG
        else process.env.TRAYAMBAK_CONFIG = savedConfig
      }
    } finally {
      fs.rmSync(lib, { recursive: true, force: true })
    }
  })

  it("on/off gates runs, enable/disable toggles a department, status reports", async () => {
    const lib = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-dispatch-company-flags-"))
    try {
      const eng = path.join(lib, "engineering")
      fs.mkdirSync(eng, { recursive: true })
      fs.writeFileSync(
        path.join(eng, "engineering-code-reviewer.md"),
        "---\nname: Code Reviewer\ndescription: Reviews code like a mentor.\n---\n\n# Code Reviewer\n",
      )
      const savedCompanyDir = process.env.TRAYAMBAK_COMPANY_DIR
      const savedConfig = process.env.TRAYAMBAK_CONFIG
      process.env.TRAYAMBAK_COMPANY_DIR = lib
      process.env.TRAYAMBAK_CONFIG = path.join(lib, "test-config.json")
      try {
        expect((await dispatch("/company off")).output).toContain("Company OFF")
        expect((await dispatch("/company run code reviewer hi")).output).toContain("Company is OFF")
        expect((await dispatch("/company status")).output).toContain("Company: OFF")
        expect((await dispatch("/company on")).output).toContain("Company ON")
        expect((await dispatch("/company disable engineering")).output).toContain("engineering disabled")
        expect((await dispatch("/company list engineering")).output).toContain("disabled division")
        expect((await dispatch("/company status")).output).toContain("disabled departments: engineering")
        expect((await dispatch("/company enable engineering")).output).toContain("engineering enabled.")
        expect((await dispatch("/company list engineering")).output).toContain("Code Reviewer")
        expect((await dispatch("/company disable nope")).output).toContain("Unknown division: nope")
      } finally {
        if (savedCompanyDir === undefined) delete process.env.TRAYAMBAK_COMPANY_DIR
        else process.env.TRAYAMBAK_COMPANY_DIR = savedCompanyDir
        if (savedConfig === undefined) delete process.env.TRAYAMBAK_CONFIG
        else process.env.TRAYAMBAK_CONFIG = savedConfig
      }
    } finally {
      fs.rmSync(lib, { recursive: true, force: true })
    }
  })
})
