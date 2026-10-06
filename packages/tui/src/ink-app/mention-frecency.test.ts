/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import * as path from "node:path"
import { filterMentions, type MentionCandidate } from "./file-mention.js"
import { FRECENCY_BOOST, frecencyKeys, rankMentionsByFrecency, rankMentionsWithHistory } from "./mention-frecency.js"
import type { FrecencyEntry } from "../../../core/src/frecency.js"

const NOW = 1_800_000_000_000
const DAY = 86_400_000
/** Windows-safe workspace root; the code re-keys with path.sep, not hardcoded "/". */
const WS = path.resolve("C:", "work", "proj")

function file(value: string): MentionCandidate {
  return { value, kind: "file" }
}
function folder(value: string): MentionCandidate {
  return { value: value.endsWith("/") ? value : `${value}/`, kind: "folder" }
}

/** An absolute store entry for a workspace-relative path. */
function recent(relative: string, opens: number, ageDays: number): FrecencyEntry {
  return {
    path: path.join(WS, ...relative.split("/")),
    opens,
    lastOpened: NOW - ageDays * DAY,
  }
}

/** Scores keyed the way `frecencyKeys` produces them. */
function keys(...entries: FrecencyEntry[]): Map<string, number> {
  return frecencyKeys(entries, WS)
}

describe("frecencyKeys", () => {
  it("re-keys an absolute store path onto the workspace-relative candidate", () => {
    // Without this re-keying every lookup misses and the boost is a silent no-op.
    const k = keys(recent("src/app.ts", 5, 0))
    expect([...k.keys()]).toEqual(["src/app.ts"])
    expect(k.get("src/app.ts")).toBeGreaterThan(0)
  })

  it("drops entries outside the workspace instead of aliasing them", () => {
    const k = frecencyKeys(
      [
        { path: path.resolve("C:", "elsewhere", "other.ts"), opens: 9, lastOpened: NOW },
        { path: path.join(WS, "in.ts"), opens: 1, lastOpened: NOW },
      ],
      WS,
    )
    expect([...k.keys()]).toEqual(["in.ts"])
  })

  it("keeps the best score when a path appears twice", () => {
    const dup = path.join(WS, "dup.ts")
    const k = frecencyKeys(
      [
        { path: dup, opens: 1, lastOpened: NOW },
        { path: dup, opens: 9, lastOpened: NOW },
      ],
      WS,
    )
    expect(k.get("dup.ts")).toBe(frecencyKeys([{ path: dup, opens: 9, lastOpened: NOW }], WS).get("dup.ts"))
  })

  it("produces nothing for an empty store", () => {
    expect(frecencyKeys([], WS).size).toBe(0)
  })
})

describe("rankMentionsByFrecency with an empty query", () => {
  const candidates = [file("src/alpha.ts"), file("src/beta.ts"), folder("src/lib")]

  it("puts the working set first — the point of opening @", () => {
    const ranked = rankMentionsByFrecency("", candidates, keys(recent("src/beta.ts", 4, 0)), 50)
    expect(ranked[0]?.value).toBe("src/beta.ts")
  })

  it("keeps folders before never-opened files in the tail", () => {
    // The existing picker's folders-first convention must survive the overlay.
    const ranked = rankMentionsByFrecency("", candidates, keys(recent("src/alpha.ts", 1, 0)), 50)
    expect(ranked[0]?.value).toBe("src/alpha.ts")
    expect(ranked[1]?.kind).toBe("folder")
  })

  it("behaves exactly like the plain picker when the store is empty", () => {
    expect(rankMentionsByFrecency("", candidates, new Map(), 50)).toEqual(filterMentions("", candidates, 50))
  })

  it("is deterministic for equal scores", () => {
    const a = rankMentionsByFrecency(
      "",
      candidates,
      keys(recent("src/alpha.ts", 3, 0), recent("src/beta.ts", 3, 0)),
      50,
    )
    const b = rankMentionsByFrecency(
      "",
      candidates,
      keys(recent("src/beta.ts", 3, 0), recent("src/alpha.ts", 3, 0)),
      50,
    )
    expect(a.map((c) => c.value)).toEqual(b.map((c) => c.value))
  })

  it("honours the limit", () => {
    expect(rankMentionsByFrecency("", candidates, keys(recent("src/beta.ts", 4, 0)), 2)).toHaveLength(2)
  })
})

describe("rankMentionsByFrecency with a query", () => {
  it("still surfaces an exact filename that has never been opened", () => {
    // Frecency must never override an explicit request; that would make the
    // picker lie about what the user typed.
    const ranked = rankMentionsByFrecency(
      "agent-loop.ts",
      [file("agent-loop.ts"), file("other.ts")],
      keys(recent("other.ts", 500, 0)),
      50,
    )
    expect(ranked[0]?.value).toBe("agent-loop.ts")
  })

  it("still applies the existing basename bonus", () => {
    const ranked = rankMentionsByFrecency("app.ts", [file("deep/nested/dir/app.ts"), file("x.ts")], new Map(), 50)
    expect(ranked[0]?.value).toBe("deep/nested/dir/app.ts")
  })

  it("floats a known file above an equally-close unknown one", () => {
    const candidates = [file("src/app.tsx"), file("src/appy.ts")]
    const plain = filterMentions("app", candidates, 50).map((c) => c.value)
    const boosted = rankMentionsByFrecency("app", candidates, keys(recent("src/appy.ts", 6, 0)), 50).map((c) => c.value)
    // The boost may reorder near-ties; it must not drop or invent a candidate.
    expect([...boosted].sort()).toEqual([...plain].sort())
    expect(boosted[0]).toBe("src/appy.ts")
  })

  it("drops candidates that do not match the query at all", () => {
    expect(rankMentionsByFrecency("zzz", [file("a.ts"), file("b.ts")], new Map(), 50)).toEqual([])
  })

  it("matches the plain picker exactly when the store is empty", () => {
    const candidates = [file("src/app.tsx"), file("src/appy.ts"), file("other.ts")]
    expect(rankMentionsByFrecency("app", candidates, new Map(), 50)).toEqual(filterMentions("app", candidates, 50))
  })

  it("never lets the boost exceed its ceiling", () => {
    expect(FRECENCY_BOOST).toBeGreaterThan(0)
    expect(FRECENCY_BOOST).toBeLessThan(1)
  })

  it("handles a single candidate and an empty list without dividing by zero", () => {
    expect(rankMentionsByFrecency("a", [file("a.ts")], keys(recent("a.ts", 3, 0)), 50)).toHaveLength(1)
    expect(rankMentionsByFrecency("a", [], new Map(), 50)).toEqual([])
  })

  it("is deterministic for equal scores", () => {
    const candidates = [file("src/app.tsx"), file("src/appy.ts")]
    const a = rankMentionsByFrecency(
      "app",
      candidates,
      keys(recent("src/app.tsx", 3, 0), recent("src/appy.ts", 3, 0)),
      50,
    )
    const b = rankMentionsByFrecency(
      "app",
      candidates,
      keys(recent("src/appy.ts", 3, 0), recent("src/app.tsx", 3, 0)),
      50,
    )
    expect(a.map((c) => c.value)).toEqual(b.map((c) => c.value))
  })

  it("does not mutate the candidate array it is given", () => {
    const candidates = [file("src/app.tsx"), file("src/appy.ts")]
    const before = JSON.stringify(candidates)
    rankMentionsByFrecency("app", candidates, keys(recent("src/appy.ts", 3, 0)), 50)
    expect(JSON.stringify(candidates)).toBe(before)
  })
})

describe("rankMentionsWithHistory", () => {
  it("goes straight from store entries to a ranked list", () => {
    const candidates = [file("src/alpha.ts"), file("src/beta.ts"), folder("src/lib")]
    const ranked = rankMentionsWithHistory("", candidates, [recent("src/beta.ts", 5, 0)], WS, 50)
    expect(ranked[0]?.value).toBe("src/beta.ts")
  })

  it("produces the plain ranking for a user with no history", () => {
    const candidates = [file("src/alpha.ts"), folder("src/lib")]
    expect(rankMentionsWithHistory("", candidates, [], WS, 50)).toEqual(filterMentions("", candidates, 50))
  })
})
