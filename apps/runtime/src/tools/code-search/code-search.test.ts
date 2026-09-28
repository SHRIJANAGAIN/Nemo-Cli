/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { formatCodeSearchResults, groupCodeSearchHits } from "./code-search.js"
import type { RgHit } from "../search/ripgrep.js"

const hit = (p: string, line: number, text: string, isMatch = true): RgHit => ({ path: p, line, text, isMatch })

describe("groupCodeSearchHits", () => {
  it("groups matches per file in first-seen order", () => {
    const hits = [hit("b.ts", 1, "one"), hit("a.ts", 2, "two"), hit("b.ts", 5, "three")]
    const out = groupCodeSearchHits(hits, 100)
    expect(out.total).toBe(3)
    expect(out.groups).toEqual([
      { file: "b.ts", lines: ["1: one", "5: three"] },
      { file: "a.ts", lines: ["2: two"] },
    ])
  })

  it("caps the total number of matches", () => {
    const hits = [hit("a.ts", 1, "one"), hit("a.ts", 2, "two"), hit("a.ts", 3, "three")]
    const out = groupCodeSearchHits(hits, 2)
    expect(out.total).toBe(2)
    expect(out.groups).toEqual([{ file: "a.ts", lines: ["1: one", "2: two"] }])
  })

  it("ignores context (non-match) hits", () => {
    const out = groupCodeSearchHits([hit("a.ts", 1, "ctx", false)], 10)
    expect(out.total).toBe(0)
    expect(out.groups).toEqual([])
  })

  it("trims line text", () => {
    const out = groupCodeSearchHits([hit("a.ts", 1, "  padded  ")], 10)
    expect(out.groups[0].lines).toEqual(["1: padded"])
  })
})

describe("formatCodeSearchResults", () => {
  it("renders the legacy grouped display format", () => {
    const grouped = groupCodeSearchHits([hit("b.ts", 1, "one"), hit("b.ts", 2, "two"), hit("a.ts", 7, "x")], 10)
    expect(formatCodeSearchResults("startServer", grouped)).toBe(
      ["3 match(es) for 'startServer':", "  b.ts (2):", "    1: one", "    2: two", "  a.ts (1):", "    7: x"].join(
        "\n",
      ),
    )
  })
})
