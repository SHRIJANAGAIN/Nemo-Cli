/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { initDatabases, resetDatabase } from "../../../../packages/core/src/state_db.js"
import { dbCommand, dbPath, dbThreads, dbViolations } from "./db.js"

let home = ""

afterEach(() => {
  resetDatabase()
  if (home) rmSync(home, { recursive: true, force: true })
  home = ""
})

function seed(): void {
  home = mkdtempSync(join(tmpdir(), "trayambak-db-"))
  const db = initDatabases(home)
  db.saveThread("t1", { model: "m" })
  db.appendEvent("t1", "message", { text: "hi" })
  db.recordViolation("filesystem", "/x", "write", 7)
  resetDatabase()
}

describe("dbPath", () => {
  it("points inside the given home", () => {
    home = mkdtempSync(join(tmpdir(), "trayambak-db-"))

    expect(dbPath(home)).toBe(join(home, "state", "state_1.json"))
  })
})

describe("dbThreads", () => {
  it("lists stored threads with timestamps", () => {
    seed()

    const out = dbThreads(home)

    expect(out).toContain("Threads (1):")
    expect(out).toContain("t1")
  })

  it("says so when empty", () => {
    home = mkdtempSync(join(tmpdir(), "trayambak-db-"))

    expect(dbThreads(home)).toBe("No threads")
  })
})

describe("dbViolations", () => {
  it("lists violations newest-first with detail", () => {
    seed()

    const out = dbViolations(home)

    expect(out).toContain("Violations (1):")
    expect(out).toContain("filesystem")
    expect(out).toContain("/x")
  })

  it("says so when empty", () => {
    home = mkdtempSync(join(tmpdir(), "trayambak-db-"))

    expect(dbViolations(home)).toBe("No violations")
  })
})

describe("dbCommand", () => {
  it("summarizes the store by default", () => {
    seed()

    const out = dbCommand("", home)

    expect(out).toContain(`State: ${join(home, "state", "state_1.json")}`)
    expect(out).toContain("threads: 1")
    expect(out).toContain("violations: 1")
  })

  it("rejects unknown actions with the available list", () => {
    expect(dbCommand("drop", home)).toContain("Unknown db action")
  })
})
