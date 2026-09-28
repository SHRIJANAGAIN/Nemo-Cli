/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { RepetitionDetector } from "./repetition.js"

const NONE = { level: 0, type: "none", detail: "", position: 0, severity: "low" } as const

describe("RepetitionDetector", () => {
  it("reports level 0 for ordinary text and tracks buffer length", () => {
    const d = new RepetitionDetector()
    const text = "Hello world, this is a perfectly ordinary sentence."
    expect(d.ingest(text)).toEqual(NONE)
    expect(d.getBufferLength()).toBe(text.length)
  })

  it("reports level 0 for empty input", () => {
    expect(new RepetitionDetector().ingest("")).toEqual(NONE)
  })

  it("flags a five-token run as level 1 token repetition", () => {
    const d = new RepetitionDetector()
    const delta = "spam spam spam spam spam"
    const r = d.ingest(delta)
    expect(r.level).toBe(1)
    expect(r.type).toBe("token")
    expect(r.detail).toBe('Token "spam" repeated 5 times consecutively')
    expect(r.severity).toBe("high")
    expect(r.position).toBe(delta.length)
  })

  it("escalates token repetition to critical at threshold + 3", () => {
    const r = new RepetitionDetector().ingest("yo yo yo yo yo yo yo yo")
    expect(r.level).toBe(1)
    expect(r.severity).toBe("critical")
  })

  it("flags a thrice-repeated bigram as level 2 ngram repetition", () => {
    const r = new RepetitionDetector().ingest("ab cd ab cd ab cd")
    expect(r.level).toBe(2)
    expect(r.type).toBe("ngram")
    expect(r.detail).toBe('2-gram "ab cd..." repeated 3 times')
    expect(r.severity).toBe("high")
  })

  it("escalates ngram repetition to critical once counts keep growing", () => {
    const d = new RepetitionDetector()
    expect(d.ingest("ab cd ab cd ab cd").level).toBe(2)
    expect(d.ingest(" ab cd").severity).toBe("high")
    const r = d.ingest(" ab cd")
    expect(r.level).toBe(2)
    expect(r.severity).toBe("critical")
  })

  it("flags a repeated long sentence as level 3 with normalized text", () => {
    const d = new RepetitionDetector()
    const s = "This is definitely a long enough sentence"
    const r = d.ingest(`${s}. ${s}.`)
    expect(r.level).toBe(3)
    expect(r.type).toBe("sentence")
    expect(r.detail).toBe(`Sentence "${s.toLowerCase()}..." repeated 2 times`)
    expect(r.severity).toBe("high")
  })

  it("escalates sentence repetition to critical at four occurrences", () => {
    const d = new RepetitionDetector({ ngramRepeatThreshold: 100 })
    const s = "This is definitely a long enough sentence"
    const r = d.ingest(`${s}. ${s}. ${s}. ${s}.`)
    expect(r.level).toBe(3)
    expect(r.severity).toBe("critical")
    expect(r.detail).toContain("repeated 4 times")
  })

  it("flags near-identical sentences as level 4 semantic repetition", () => {
    const d = new RepetitionDetector()
    const s1 = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima one"
    const s2 = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima two"
    const r = d.ingest(`${s1}. ${s2}.`)
    expect(r.level).toBe(4)
    expect(r.type).toBe("semantic")
    expect(r.detail.startsWith("Semantically similar (86%):")).toBe(true)
    expect(r.severity).toBe("high")
  })

  it("escalates semantic repetition to critical at >= 95% similarity", () => {
    const d = new RepetitionDetector()
    const words = [
      "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india",
      "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra",
    ]
    const s1 = words.join(" ")
    const s2 = `${s1} zulu`
    const r = d.ingest(`${s1}. ${s2}.`)
    expect(r.level).toBe(4)
    expect(r.detail.startsWith("Semantically similar (95%):")).toBe(true)
    expect(r.severity).toBe("critical")
  })

  it("honors a custom token threshold from the constructor", () => {
    const r = new RepetitionDetector({ tokenRepeatThreshold: 2 }).ingest("hi hi")
    expect(r.level).toBe(1)
    expect(r.type).toBe("token")
    expect(r.severity).toBe("high")
  })

  it("clears the buffer and counters on reset", () => {
    const d = new RepetitionDetector()
    expect(d.ingest("ab cd ab cd ab cd").level).toBe(2)
    expect(d.getBufferLength()).toBe("ab cd ab cd ab cd".length)
    d.reset()
    expect(d.getBufferLength()).toBe(0)
    expect(d.ingest("Hello there friend")).toEqual(NONE)
  })
})
