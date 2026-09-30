/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { initDatabases } from "../../../../packages/core/src/state_db.js"
import { collectStats, formatStats, statsCommand } from "./stats.js"

let home = ""

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true })
  home = ""
})

describe("collectStats", () => {
  it("aggregates sessions, events, violations, and activity bounds", () => {
    const stats = collectStats({
      threads: [
        { id: "a", created_at: 100, updated_at: 300 },
        { id: "b", created_at: 200, updated_at: 250 },
      ],
      eventCounts: { a: 4, b: 6 },
      violations: 2,
    })

    expect(stats).toEqual({ sessions: 2, events: 10, violations: 2, oldestActivity: 100, newestActivity: 300 })
  })

  it("reports null activity bounds for an empty store", () => {
    expect(collectStats({ threads: [], eventCounts: {}, violations: 0 })).toEqual({
      sessions: 0,
      events: 0,
      violations: 0,
      oldestActivity: null,
      newestActivity: null,
    })
  })
})

describe("formatStats", () => {
  it("renders every stat on its own line", () => {
    const out = formatStats({ sessions: 1, events: 2, violations: 0, oldestActivity: null, newestActivity: 500 })

    expect(out).toContain("sessions: 1")
    expect(out).toContain("events: 2")
    expect(out).toContain("violations: 0")
    expect(out).toContain("oldest activity: none")
    expect(out).toContain(new Date(500).toISOString())
  })
})

describe("statsCommand", () => {
  it("reads a throwaway store without touching the real one", () => {
    home = mkdtempSync(join(tmpdir(), "trayambak-stats-"))
    const db = initDatabases(home)
    db.saveThread("t1", { model: "m" })
    db.appendEvent("t1", "message", { text: "hi" })
    db.recordViolation("filesystem", "/x", "write", 1)

    const out = statsCommand(home)

    expect(out).toContain("sessions: 1")
    expect(out).toContain("events: 1")
    expect(out).toContain("violations: 1")
  })

  it("reports zeros for a fresh store", () => {
    home = mkdtempSync(join(tmpdir(), "trayambak-stats-"))

    const out = statsCommand(home)

    expect(out).toContain("sessions: 0")
    expect(out).toContain("events: 0")
  })
})
