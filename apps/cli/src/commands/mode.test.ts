/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type * as ModeModule from "./mode.js"

/**
 * mode.ts binds MODE_FILE to os.homedir() AT MODULE LOAD and (round 13)
 * really persists `set` there — so a throwaway home is installed before
 * the dynamic import and the real ~/.trayambak/mode.json is never read or
 * written. `import type` above is erased and cannot pull the module in
 * early. Error-path strings are still asserted exactly: they are what the
 * CLI prints when a user typos a mode.
 */

let mode: typeof ModeModule
let home = ""
let savedUserprofile: string | undefined
let savedHome: string | undefined

const KNOWN: ModeModule.ModeName[] = ["default", "plan", "architect", "code", "debug", "review"]
const modeFile = (): string => path.join(home, ".trayambak", "mode.json")

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-mode-home-"))
  savedUserprofile = process.env.USERPROFILE
  savedHome = process.env.HOME
  process.env.USERPROFILE = home
  process.env.HOME = home
  mode = await import("./mode.js")
  process.env.USERPROFILE = savedUserprofile
  process.env.HOME = savedHome
})

afterAll(() => {
  try {
    fs.rmSync(home, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

beforeEach(() => {
  fs.rmSync(modeFile(), { force: true })
})

describe("modeCommand", () => {
  it("lists every mode as a bullet under the header", () => {
    expect(mode.modeCommand({ action: "list" })).toBe(
      "Available modes:\n" + KNOWN.map((m) => `  - ${m}`).join("\n"),
    )
  })

  it("reports the default mode when nothing was ever set", () => {
    expect(mode.modeCommand({ action: "current" })).toBe("Current mode: default")
  })

  it("set really persists — current reflects it (round 13: was acknowledge-only)", () => {
    for (const m of KNOWN) {
      expect(mode.modeCommand({ action: "set", mode: m })).toBe(`Mode set to: ${m}`)
      expect(mode.modeCommand({ action: "current" })).toBe(`Current mode: ${m}`)
    }
    const stored = JSON.parse(fs.readFileSync(modeFile(), "utf8")) as { mode?: string }
    expect(stored.mode).toBe("review")
  })

  it("falls back to default for a corrupt or bogus mode file instead of throwing", () => {
    fs.mkdirSync(path.dirname(modeFile()), { recursive: true })
    fs.writeFileSync(modeFile(), "{ not json", "utf8")
    expect(mode.modeCommand({ action: "current" })).toBe("Current mode: default")

    fs.writeFileSync(modeFile(), JSON.stringify({ mode: "hacker" }), "utf8")
    expect(mode.modeCommand({ action: "current" })).toBe("Current mode: default")
  })

  it("requires a mode for the set action", () => {
    expect(mode.modeCommand({ action: "set" })).toBe("Missing mode")
  })

  it("rejects an unknown mode, enumerates the valid ones, and persists nothing", () => {
    const out = mode.modeCommand({ action: "set", mode: "hacker" as unknown as ModeModule.ModeName })
    expect(out).toBe("Unknown mode: hacker. Available: default, plan, architect, code, debug, review")
    expect(fs.existsSync(modeFile())).toBe(false)
    expect(mode.modeCommand({ action: "current" })).toBe("Current mode: default")
  })

  it("falls through for an unrecognized action", () => {
    expect(mode.modeCommand({ action: "sideways" as never })).toBe("Unknown mode action: sideways")
  })
})
