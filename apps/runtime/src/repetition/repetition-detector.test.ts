/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { RepetitionDetector } from "./repetition-detector.js"

describe("runtime RepetitionDetector", () => {
  it("reports nothing for a fresh detector", () => {
    expect(new RepetitionDetector().detect()).toEqual([])
  })

  it("flags a token that reaches ten occurrences across records", () => {
    const d = new RepetitionDetector()
    for (let i = 0; i < 10; i++) d.record(`spam number${i}`)
    expect(d.detect()).toEqual([{ level: "token", count: 10, sample: "spam" }])
  })

  it("flags an ngram that reaches five occurrences across records", () => {
    const d = new RepetitionDetector()
    for (let i = 0; i < 5; i++) d.record(`alpha beta gamma ${i}`)
    expect(d.detect()).toEqual([{ level: "ngram", count: 5, sample: "alpha beta" }])
  })

  it("flags a sentence repeated three times in a single record", () => {
    const d = new RepetitionDetector()
    d.record("This is fine. This is fine. This is fine.")
    expect(d.detect()).toEqual([{ level: "sentence", count: 3, sample: "This is fine" }])
  })

  it("flags a tool invoked six times", () => {
    const d = new RepetitionDetector()
    for (let i = 0; i < 6; i++) d.record(`item${i} ran item${i}x tool item${i}y`, "bash")
    expect(d.detect()).toEqual([{ level: "tool", count: 6, sample: "bash" }])
  })

  it("flags a strategy invoked four times", () => {
    const d = new RepetitionDetector()
    for (let i = 0; i < 4; i++) d.record(`item${i} alpha${i} beta${i} gamma${i}`, undefined, "reflect")
    expect(d.detect()).toEqual([{ level: "strategy", count: 4, sample: "reflect" }])
  })

  it("clears every counter on reset", () => {
    const d = new RepetitionDetector()
    for (let i = 0; i < 10; i++) d.record(`spam number${i}`, "bash", "reflect")
    expect(d.detect().map((r) => r.level).sort()).toEqual(["strategy", "token", "tool"].sort())
    d.reset()
    expect(d.detect()).toEqual([])
  })
})
