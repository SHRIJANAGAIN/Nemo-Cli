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
  FRECENCY_VERSION,
  MAX_ENTRIES,
  OPENS_DEDUPE_MS,
  frecencyScore,
  loadFrecency,
  mergeFrecency,
  prune,
  rankByFrecency,
  recordOpen,
  saveFrecency,
  touchAndRank,
  frecencyStorePath,
  noteOpen,
  rankedRecents,
  type FrecencyEntry,
} from "./frecency.js"

const DAY = 86_400_000
/** Fixed clock so every ranking assertion is deterministic. */
const NOW = 1_800_000_000_000

let dir: string
let storePath: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-frecency-"))
  storePath = path.join(dir, "nested", "frecency.json")
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** A store file that really exists on disk, not an in-memory stand-in. */
function writeStore(entries: readonly FrecencyEntry[], version = FRECENCY_VERSION): string {
  fs.mkdirSync(path.dirname(storePath), { recursive: true })
  fs.writeFileSync(storePath, JSON.stringify({ version, entries }), "utf8")
  return storePath
}

function entry(p: string, opens: number, ageDays: number): FrecencyEntry {
  return { path: p, opens, lastOpened: NOW - ageDays * DAY }
}

describe("frecencyScore", () => {
  it("divides frequency by age, so recency wins over a stale hot file", () => {
    // 100 opens a year ago must lose to 2 opens this morning.
    expect(frecencyScore(entry("old.ts", 100, 365), NOW)).toBeLessThan(frecencyScore(entry("new.ts", 2, 0), NOW))
  })

  it("rewards repetition within the same day", () => {
    expect(frecencyScore(entry("a.ts", 10, 0), NOW)).toBeGreaterThan(frecencyScore(entry("b.ts", 1, 0), NOW))
  })

  it("scores a never-opened entry zero instead of NaN", () => {
    expect(frecencyScore({ path: "x.ts", opens: 0, lastOpened: NOW }, NOW)).toBe(0)
    expect(frecencyScore({ path: "x.ts", opens: 3, lastOpened: 0 }, NOW)).toBe(0)
  })

  it("does not go negative when the clock skews into the future", () => {
    expect(Number.isFinite(frecencyScore({ path: "x.ts", opens: 3, lastOpened: NOW + DAY }, NOW))).toBe(true)
    expect(frecencyScore({ path: "x.ts", opens: 3, lastOpened: NOW + DAY }, NOW)).toBeGreaterThan(0)
  })

  it("caps age so a stale entry cannot divide itself into irrelevance", () => {
    // Without the cap a 5-year-old file would score ~0.0005 and sort below noise.
    const ancient = frecencyScore(entry("ancient.ts", 2, 3650), NOW, 90)
    expect(ancient).toBeGreaterThan(0)
  })
})

describe("rankByFrecency", () => {
  it("puts the working set above the one-off opens", () => {
    const ranked = rankByFrecency([entry("stale.ts", 90, 300), entry("working.ts", 6, 0), entry("newcomer.ts", 1, 0)], {
      now: NOW,
    })
    expect(ranked[0]?.path).toBe("working.ts")
    expect(ranked[1]?.path).toBe("newcomer.ts")
    expect(ranked[2]?.path).toBe("stale.ts")
  })

  it("breaks ties deterministically so the list cannot flicker between keystrokes", () => {
    const a = rankByFrecency([entry("b.ts", 5, 1), entry("a.ts", 5, 1)], { now: NOW })
    const b = rankByFrecency([entry("a.ts", 5, 1), entry("b.ts", 5, 1)], { now: NOW })
    expect(a.map((e) => e.path)).toEqual(["a.ts", "b.ts"])
    expect(b.map((e) => e.path)).toEqual(a.map((e) => e.path))
  })

  it("breaks a score tie on recency", () => {
    const ranked = rankByFrecency([entry("older.ts", 4, 2), entry("newer.ts", 4, 1)], { now: NOW })
    expect(ranked[0]?.path).toBe("newer.ts")
  })

  it("filters case-insensitively, which is what a typed path fragment needs", () => {
    const ranked = rankByFrecency([entry("src/App.tsx", 5, 0), entry("docs/readme.md", 9, 0)], {
      now: NOW,
      filter: "app",
    })
    expect(ranked.map((e) => e.path)).toEqual(["src/App.tsx"])
  })

  it("honours a limit and survives a negative one", () => {
    const many = [entry("a.ts", 9, 0), entry("b.ts", 8, 0), entry("c.ts", 7, 0)]
    expect(rankByFrecency(many, { now: NOW, limit: 2 })).toHaveLength(2)
    expect(rankByFrecency(many, { now: NOW, limit: -1 })).toHaveLength(0)
  })

  it("does not mutate its input", () => {
    const input = [entry("a.ts", 1, 5), entry("b.ts", 2, 0)]
    const snapshot = JSON.stringify(input)
    rankByFrecency(input, { now: NOW })
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

describe("recordOpen", () => {
  it("creates a first entry with one open", () => {
    const next = recordOpen([], "src/a.ts", NOW)
    expect(next).toEqual([{ path: "src/a.ts", opens: 1, lastOpened: NOW }])
  })

  it("counts a genuinely separate visit", () => {
    const next = recordOpen([{ path: "a.ts", opens: 1, lastOpened: NOW - 10 * DAY }], "a.ts", NOW)
    expect(next[0]?.opens).toBe(2)
  })

  it("collapses opens inside the dedupe window so autocomplete cannot inflate the count", () => {
    let entries: FrecencyEntry[] = []
    for (let i = 0; i < 50; i++) entries = recordOpen(entries, "a.ts", NOW + i)
    expect(entries[0]?.opens).toBe(1)
  })

  it("counts again once the dedupe window has passed", () => {
    const start = recordOpen([], "a.ts", NOW)
    const later = recordOpen(start, "a.ts", NOW + OPENS_DEDUPE_MS + 1)
    expect(later[0]?.opens).toBe(2)
  })

  it("does not let a backwards clock pin an entry to the top forever", () => {
    const entries = recordOpen([{ path: "a.ts", opens: 1, lastOpened: NOW + DAY }], "a.ts", NOW)
    expect(entries[0]?.lastOpened).toBe(NOW + DAY)
  })
})

describe("prune", () => {
  it("keeps the strongest entries when over the cap", () => {
    const many = Array.from({ length: MAX_ENTRIES + 50 }, (_, i) => entry(`f${i}.ts`, i + 1, 0))
    const kept = prune(many)
    expect(kept).toHaveLength(MAX_ENTRIES)
    expect(kept.some((e) => e.path === "f0.ts")).toBe(false)
    expect(kept.some((e) => e.path === `f${MAX_ENTRIES + 49}.ts`)).toBe(true)
  })

  it("keeps an old heavily-used file that a last/first trim would discard", () => {
    const many = [
      entry("ancient_hot.ts", 999, 300),
      ...Array.from({ length: MAX_ENTRIES }, (_, i) => entry(`f${i}.ts`, 1, 0)),
    ]
    expect(prune(many).some((e) => e.path === "ancient_hot.ts")).toBe(true)
  })
})

describe("mergeFrecency", () => {
  it("keeps the best open count and the newest open per path", () => {
    const merged = mergeFrecency(
      [{ path: "a.ts", opens: 7, lastOpened: NOW - DAY }],
      [
        { path: "a.ts", opens: 2, lastOpened: NOW },
        { path: "b.ts", opens: 1, lastOpened: NOW },
      ],
    )
    expect(merged).toHaveLength(2)
    expect(merged.find((e) => e.path === "a.ts")).toEqual({ path: "a.ts", opens: 7, lastOpened: NOW })
  })
})

describe("loadFrecency", () => {
  it("reads back what was saved, through a real file", () => {
    writeStore([entry("a.ts", 3, 0)])
    expect(loadFrecency(storePath)).toEqual([{ path: "a.ts", opens: 3, lastOpened: NOW }])
  })

  it("returns empty for a missing file instead of throwing", () => {
    expect(loadFrecency(path.join(dir, "nope.json"))).toEqual([])
  })

  it("returns empty for truncated JSON — this runs on the @ keystroke path", () => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    fs.writeFileSync(storePath, '{"version":1,"entries":[{"path"', "utf8")
    expect(loadFrecency(storePath)).toEqual([])
  })

  it("rejects an unknown version rather than misreading a future format", () => {
    writeStore([entry("a.ts", 3, 0)], 999)
    expect(loadFrecency(storePath)).toEqual([])
  })

  it("drops malformed rows but keeps the good ones", () => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        version: FRECENCY_VERSION,
        entries: [
          null,
          { path: "", opens: 1, lastOpened: NOW },
          { path: "ok.ts", opens: 1, lastOpened: NOW },
          { opens: 1 },
        ],
      }),
      "utf8",
    )
    expect(loadFrecency(storePath)).toEqual([{ path: "ok.ts", opens: 1, lastOpened: NOW }])
  })

  it("rejects a non-array entries field", () => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    fs.writeFileSync(storePath, JSON.stringify({ version: FRECENCY_VERSION, entries: "nope" }), "utf8")
    expect(loadFrecency(storePath)).toEqual([])
  })
})

describe("saveFrecency", () => {
  it("creates missing directories — the store lives under an unwritten config dir", () => {
    saveFrecency(storePath, [entry("a.ts", 1, 0)])
    expect(fs.existsSync(storePath)).toBe(true)
  })

  it("leaves no temp file behind after a successful write", () => {
    saveFrecency(storePath, [entry("a.ts", 1, 0)])
    expect(fs.readdirSync(path.dirname(storePath)).filter((f) => f.includes(".tmp"))).toEqual([])
  })

  it("produces a store that reads back identically", () => {
    const rows = [entry("a.ts", 2, 0), entry("b.ts", 5, 1)]
    saveFrecency(storePath, rows)
    expect(loadFrecency(storePath)).toEqual(rows)
  })

  it("is idempotent across repeated writes", () => {
    const rows = [entry("a.ts", 2, 0)]
    saveFrecency(storePath, rows)
    saveFrecency(storePath, rows)
    expect(loadFrecency(storePath)).toEqual(rows)
  })
})

describe("touchAndRank", () => {
  it("persists the open and ranks it first", () => {
    const ranked = touchAndRank(storePath, "hot.ts", { now: NOW })
    expect(ranked[0]?.path).toBe("hot.ts")
    expect(loadFrecency(storePath)).toEqual([{ path: "hot.ts", opens: 1, lastOpened: NOW }])
  })

  it("accumulates across calls without hand-rolled bookkeeping", () => {
    touchAndRank(storePath, "a.ts", { now: NOW - 10 * DAY })
    touchAndRank(storePath, "a.ts", { now: NOW })
    expect(loadFrecency(storePath).find((e) => e.path === "a.ts")?.opens).toBe(2)
  })

  it("still ranks when the store is corrupt — ranking is a convenience, not a requirement", () => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    fs.writeFileSync(storePath, "not json at all", "utf8")
    expect(touchAndRank(storePath, "a.ts", { now: NOW })[0]?.path).toBe("a.ts")
  })

  it("creates a real store file from nothing", () => {
    expect(fs.existsSync(storePath)).toBe(false)
    touchAndRank(storePath, "a.ts", { now: NOW })
    expect(fs.statSync(storePath).isFile()).toBe(true)
  })
})

describe("default store path", () => {
  const savedStateDir = process.env.TRAYAMBAK_STATE_DIR

  afterEach(() => {
    if (savedStateDir === undefined) delete process.env.TRAYAMBAK_STATE_DIR
    else process.env.TRAYAMBAK_STATE_DIR = savedStateDir
  })

  it("honours TRAYAMBAK_STATE_DIR instead of writing into the user's home", () => {
    process.env.TRAYAMBAK_STATE_DIR = dir
    expect(frecencyStorePath()).toBe(path.join(dir, "frecency.json"))
  })

  it("falls back to ~/.trayambak when the override is empty", () => {
    // An empty override is what an unset shell variable expands to; treating it
    // as a path would write the store to a relative "frecency.json" in the cwd.
    process.env.TRAYAMBAK_STATE_DIR = ""
    expect(path.isAbsolute(frecencyStorePath())).toBe(true)
  })

  it("noteOpen writes to the resolved store, not the caller's directory", () => {
    process.env.TRAYAMBAK_STATE_DIR = dir
    noteOpen("src/a.ts", NOW)
    expect(loadFrecency(path.join(dir, "frecency.json"))).toEqual([{ path: "src/a.ts", opens: 1, lastOpened: NOW }])
  })

  it("noteOpen never throws, even with an unusable store path", () => {
    // A file where a directory is expected: mkdirSync fails inside saveFrecency.
    fs.writeFileSync(path.join(dir, "blocked"), "x", "utf8")
    process.env.TRAYAMBAK_STATE_DIR = path.join(dir, "blocked")
    expect(() => noteOpen("a.ts", NOW)).not.toThrow()
  })

  it("rankedRecents returns the default store already ranked", () => {
    process.env.TRAYAMBAK_STATE_DIR = dir
    noteOpen("cold.ts", NOW - 30 * DAY)
    noteOpen("cold.ts", NOW - 30 * DAY + OPENS_DEDUPE_MS + 1)
    noteOpen("warm.ts", NOW)
    expect(rankedRecents({ now: NOW }).map((e) => e.path)[0]).toBe("warm.ts")
  })
})
