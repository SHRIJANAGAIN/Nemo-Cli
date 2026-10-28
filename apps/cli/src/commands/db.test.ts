/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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
  home = mkdtempSync(join(tmpdir(), "nemo-db-"))
  const db = initDatabases(home)
  db.saveThread("t1", { model: "m" })
  db.appendEvent("t1", "message", { text: "hi" })
  db.recordViolation("filesystem", "/x", "write", 7)
  resetDatabase()
}

describe("dbPath", () => {
  it("points inside the given home", () => {
    home = mkdtempSync(join(tmpdir(), "nemo-db-"))

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
    home = mkdtempSync(join(tmpdir(), "nemo-db-"))

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
    home = mkdtempSync(join(tmpdir(), "nemo-db-"))

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
    process.exitCode = undefined
    expect(dbCommand("drop", home)).toContain("Unknown db action")
    expect(process.exitCode).toBe(2)
    process.exitCode = undefined
  })
})
