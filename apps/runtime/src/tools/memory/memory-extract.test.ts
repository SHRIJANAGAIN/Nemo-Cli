/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { extractMemoryCandidates } from "./memory.js"

describe("extractMemoryCandidates", () => {
  it("catches explicit remember phrasing", () => {
    const out = extractMemoryCandidates("Please remember that I use pwsh on Windows")
    expect(out).toEqual([{ content: "I use pwsh on Windows", category: "preference" }])
  })

  it("catches preferences and decisions with categories", () => {
    expect(extractMemoryCandidates("I prefer tabs over spaces")[0]).toMatchObject({ category: "preference" })
    expect(extractMemoryCandidates("We decided that deploys go on Fridays")[0]).toMatchObject({ category: "decision" })
    expect(extractMemoryCandidates("My name is Ada")[0]).toMatchObject({ category: "context" })
  })

  it("catches note: lines and my-X-is facts", () => {
    expect(extractMemoryCandidates("Note: the staging DB is read-only")[0]?.content).toContain("staging DB")
    expect(extractMemoryCandidates("my shell is pwsh")[0]).toMatchObject({ category: "context" })
  })

  it("ignores transient breakage reports", () => {
    expect(extractMemoryCandidates("my build is broken since lunch")).toEqual([])
    expect(extractMemoryCandidates("my tests are failing on main")).toEqual([])
  })

  it("keeps explicit remembers even with transient words", () => {
    const out = extractMemoryCandidates("Remember that the old API is broken, use v2")
    expect(out.length).toBe(1)
  })

  it("returns nothing for plain chatter", () => {
    expect(extractMemoryCandidates("hi, how are you today?")).toEqual([])
    expect(extractMemoryCandidates("")).toEqual([])
    expect(extractMemoryCandidates("ok")).toEqual([])
  })

  it("caps at max and dedupes repeats", () => {
    const text = [
      "Remember that the alpha flag stays on",
      "Remember that the beta path is frozen",
      "Remember that gamma needs a review pass",
      "Remember that the alpha flag stays on",
    ].join(". ")
    const out = extractMemoryCandidates(text, 3)
    expect(out.map((c) => c.content)).toEqual([
      "the alpha flag stays on",
      "the beta path is frozen",
      "gamma needs a review pass",
    ])
    expect(extractMemoryCandidates(text, 2).length).toBe(2)
  })

  it("trims quotes and whitespace", () => {
    const out = extractMemoryCandidates('Remember that "tabs win" ')
    expect(out[0]?.content).toBe("tabs win")
  })
})
