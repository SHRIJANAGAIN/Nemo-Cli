/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { initDatabases } from "../../../../packages/core/src/state_db.js"
import { collectStats, formatStats, statsCommand, transcriptStats, transcriptStatsCommand } from "./stats.js"

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
    home = mkdtempSync(join(tmpdir(), "nemo-stats-"))
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
    home = mkdtempSync(join(tmpdir(), "nemo-stats-"))

    const out = statsCommand(home)

    expect(out).toContain("sessions: 0")
    expect(out).toContain("events: 0")
  })

  it("omits the cost line entirely when no usage was recorded", () => {
    // "no usage yet" and "free" are different facts. A fresh store must not
    // print "$0.00", which reads as a completed free run.
    home = mkdtempSync(join(tmpdir(), "nemo-stats-"))
    initDatabases(home)
    expect(statsCommand(home)).not.toContain("estimated cost")
  })
})

describe("cost line", () => {
  it("shows an estimated cost when usage is supplied", () => {
    const stats = collectStats({
      threads: [],
      eventCounts: {},
      violations: 0,
      usage: [{ provider: "nvidia", model: "nvidia/nemotron-3-super-120b-a12b", inputTokens: 1_000_000, outputTokens: 1_000_000 }],
    })
    expect(stats.cost).toBeDefined()
    expect(formatStats(stats)).toContain("estimated cost")
    expect(formatStats(stats)).toContain("nvidia/nemotron-3-super-120b-a12b")
    expect(formatStats(stats)).toContain("$2.40")
  })

  it("flags a partial total when a model has no price row", () => {
    // Without this marker a total that silently omits an unpriced model reads
    // as a complete bill.
    const stats = collectStats({
      threads: [],
      eventCounts: {},
      violations: 0,
      usage: [
        { provider: "nvidia", model: "nvidia/nemotron-3-super-120b-a12b", inputTokens: 1000, outputTokens: 1000 },
        { provider: "mystery", model: "unknown-9000", inputTokens: 1000, outputTokens: 1000 },
      ],
    })
    expect(formatStats(stats)).toContain("partial")
  })

  it("treats a local runtime as free but still priced", () => {
    const stats = collectStats({
      threads: [],
      eventCounts: {},
      violations: 0,
      usage: [{ provider: "ollama", model: "local", inputTokens: 500_000, outputTokens: 500_000 }],
    })
    expect(stats.cost!.usd).toBe(0)
    expect(stats.cost!.hasUnknownModel).toBe(false)
    expect(formatStats(stats)).toContain("$0.00")
    expect(formatStats(stats)).not.toContain("partial")
  })

  it("an empty usage array yields no cost line", () => {
    const stats = collectStats({ threads: [], eventCounts: {}, violations: 0, usage: [] })
    expect(stats.cost).toBeUndefined()
    expect(formatStats(stats)).not.toContain("estimated cost")
  })
})

describe("transcriptStats", () => {
  /**
   * These take RECORDS, not a session id. `apps/cli` may only import
   * `packages/core` and `packages/execpolicy`, so the filesystem half lives in
   * session-backends (`readTranscriptStats`) and injects the records. The lint
   * rule forbids grandfathering the import to work around this.
   */

  const RECORDS = [
    { role: "user", content: "read the config", t: 1_000 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }],
      stopReason: "tool_use",
      t: 1_200,
    },
    {
      role: "tool",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "file" }],
      isError: false,
      t: 1_300,
    },
    { role: "assistant", content: [{ type: "text", text: "here it is" }], stopReason: "end_turn", t: 2_000 },
  ]

  it("reports turns, tool calls, and the span of a real transcript", () => {
    const stats = transcriptStats(RECORDS)
    expect(stats.turns).toBe(1)
    expect(stats.toolCalls).toBe(1)
    expect(stats.tools[0]!.name).toBe("read")
    expect(stats.spanMs).toBe(1_000)
  })

  it("formats a report that names the session", () => {
    const text = transcriptStatsCommand("sess-42", RECORDS)
    expect(text).toContain("sess-42")
    expect(text).toContain("read")
    expect(text).toContain("estimated")
  })

  it("does not claim a cost figure it cannot compute", () => {
    // Provider token counts are never written to disk, so a dollar figure here
    // would be fabricated. `cost_tracker` covers the live case.
    expect(transcriptStatsCommand("s", RECORDS)).not.toContain("$")
  })

  it("survives malformed records without throwing", () => {
    const stats = transcriptStats([{ role: "user", content: "hi", t: 1 }, { nonsense: true }])
    expect(stats.skipped).toBe(1)
    expect(stats.turns).toBe(1)
  })

  it("an empty record set reports zeroes rather than vanishing", () => {
    const stats = transcriptStats([])
    expect(stats.records).toBe(0)
    expect(stats.turns).toBe(0)
  })
})