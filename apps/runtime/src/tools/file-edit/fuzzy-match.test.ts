/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { findOldStringSpans } from "./fuzzy-match.js"

function apply(original: string, oldStr: string): { text: string; pass: string } | null {
  const spans = findOldStringSpans(original, oldStr)
  if (spans.length !== 1) return null
  const s = spans[0] as { start: number; end: number; pass: string }
  return { text: original.slice(0, s.start) + "<NEW>" + original.slice(s.end), pass: s.pass }
}

describe("findOldStringSpans", () => {
  it("matches exact text as the first pass", () => {
    const out = apply("line1\nline2\nline3", "line2")
    expect(out).toEqual({ text: "line1\n<NEW>\nline3", pass: "exact" })
  })

  it("tolerates trailing whitespace (trimEnd pass)", () => {
    const out = apply("const x = 1;   \nnext();", "const x = 1;")
    expect(out?.pass).toBe("trimEnd")
    expect(out?.text).toBe("<NEW>\nnext();")
  })

  it("tolerates indentation drift (trim pass)", () => {
    const out = apply("if (ok) {\n    run();\n}", "  run();")
    expect(out?.pass).toBe("trim")
    expect(out?.text).toBe("if (ok) {\n<NEW>\n}")
  })

  it("matches across CRLF/LF line-ending drift", () => {
    const out = apply("a\r\nb\r\nc", "a\nb")
    expect(out?.text).toBe("<NEW>\r\nc")
  })

  it("normalizes smart quotes and dashes (unicode pass)", () => {
    const out = apply("it\u2019s a \u2014 test", "it's a - test")
    expect(out?.pass).toBe("unicode")
    expect(out?.text).toBe("<NEW>")
  })

  it("matches multi-line blocks and splices cleanly", () => {
    const out = apply("head\n  old1();\nold2();\ntail", "old1();\nold2();")
    expect(out?.text).toBe("head\n<NEW>\ntail")
  })

  it("returns every span when the loose match is ambiguous", () => {
    const spans = findOldStringSpans("  run();\n  run();", "run();")
    expect(spans.length).toBe(2)
    expect(spans[0]?.pass).toBe("trim")
  })

  it("returns empty when nothing matches at any pass", () => {
    expect(findOldStringSpans("alpha\nbeta", "gamma delta")).toEqual([])
  })

  it("refuses empty needles and empty old strings", () => {
    expect(findOldStringSpans("abc", "")).toEqual([])
    expect(findOldStringSpans("", "x")).toEqual([])
  })

  it("does not glue the next line onto the replacement", () => {
    const out = apply("first\nsecond\nthird", "second")
    expect(out?.text).toBe("first\n<NEW>\nthird")
  })
})
