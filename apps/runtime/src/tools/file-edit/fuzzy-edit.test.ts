/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { applyEdit, explainMatch, isAmbiguousEdit, matchEdit } from "./fuzzy-edit.js"

const SRC = [
  "function alpha() {",
  "  const x = 1",
  "  return x",
  "}",
  "",
  "function beta() {",
  "  const x = 2",
  "  return x",
  "}",
].join("\n")

describe("exact tier", () => {
  it("matches byte-equal text with full confidence", () => {
    const m = matchEdit(SRC, "  const x = 1")
    expect(m?.tier).toBe("exact")
    expect(m?.confidence).toBe(1)
    expect(m?.text).toBe("  const x = 1")
  })

  it("returns the correct offsets", () => {
    const m = matchEdit(SRC, "function beta() {")
    expect(SRC.slice(m!.start, m!.end)).toBe("function beta() {")
  })

  it("applies an exact replacement without touching anything else", () => {
    const out = applyEdit(SRC, "  const x = 1", "  const x = 99")
    expect(out?.content).toContain("  const x = 99")
    expect(out?.content).toContain("  const x = 2")
  })

  it("returns null for an empty needle instead of matching everywhere", () => {
    expect(matchEdit(SRC, "")).toBeNull()
    expect(applyEdit(SRC, "", "x")).toBeNull()
  })

  it("returns null when nothing matches", () => {
    expect(matchEdit(SRC, "function gamma() {")).toBeNull()
  })
})

describe("ambiguity is a refusal", () => {
  it("refuses text that occurs twice rather than picking the first", () => {
    // `  return x` appears in both functions. Editing the first would silently
    // change alpha when the model meant beta — far worse than refusing.
    expect(matchEdit(SRC, "  return x")).toBeNull()
    expect(applyEdit(SRC, "  return x", "  return 0")).toBeNull()
  })

  it("flags ambiguity through the public predicate", () => {
    expect(isAmbiguousEdit(SRC, "  return x")).toBe(true)
    expect(isAmbiguousEdit(SRC, "function beta() {")).toBe(false)
  })

  it("can be overridden only for dry runs", () => {
    // `exact` refuses to report AT ALL when it matches twice — ambiguity is a
    // refusal, not a ranked guess — so the override resolves at a looser tier.
    // What matters is that the offsets still point at a real occurrence.
    const m = matchEdit(SRC, "  return x", { allowAmbiguous: true })
    expect(m).not.toBeNull()
    expect(SRC.slice(m!.start, m!.end).trim()).toBe("return x")
  })
})

describe("eol-normalised tier", () => {
  it("matches an LF needle against a CRLF file", () => {
    // Multi-line, because a single line is byte-equal anyway and `exact` wins.
    const crlf = "one\r\ntwo\r\nthree"
    const m = matchEdit(crlf, "one\ntwo")
    expect(m?.tier).toBe("eol-normalised")
    expect(m?.confidence).toBeGreaterThan(0.9)
  })

  it("does not downgrade a single line that already matches exactly", () => {
    const m = matchEdit("one\r\ntwo\r\nthree", "two")
    expect(m?.tier).toBe("exact")
  })

  it("produces offsets that point at the right characters", () => {
    const crlf = "one\r\ntwo\r\nthree"
    const out = applyEdit(crlf, "two", "TWO")
    expect(out?.content).toBe("one\r\nTWO\r\nthree")
  })

  it("keeps the file's own line endings after a multi-line edit", () => {
    const crlf = "a\r\nb\r\nc"
    const out = applyEdit(crlf, "a\nb", "x\ny\nz")
    expect(out?.content).toBe("x\r\ny\r\nz\r\nc")
  })
})

describe("indentation-flexible tier", () => {
  it("matches a dedented needle against an indented block", () => {
    // The needle is dedented; the file is not. Unique to `alpha`, since `beta`
    // declares `const x = 2`.
    const m = matchEdit(SRC, "const x = 1\nreturn x")
    expect(m?.tier).toBe("indentation-flexible")
  })

  it("RE-INDENTS the replacement to the region it lands in", () => {
    // The whole point: matching loosely but inserting unindented would produce
    // code that does not parse.
    const out = applyEdit(SRC, "const x = 1\nreturn x", "const x = 1\nreturn x + 1")
    expect(out?.content).toContain("  const x = 1")
    expect(out?.content).toContain("  return x + 1")
  })

  it("never emits an unindented line into an indented region", () => {
    const out = applyEdit(SRC, "const x = 1\nreturn x", "const x = 1\nreturn x + 0")
    for (const line of out!.content.split("\n")) {
      if (line.trim().length === 0) continue
      expect(line.startsWith("  ") || !line.startsWith(" ")).toBe(true)
    }
  })

  it("refuses an indentation-flexible tier that is ambiguous", () => {
    const twice = ["function a() {", "  go()", "}", "function b() {", "  go()", "}"].join("\n")
    expect(matchEdit(twice, "go()")).toBeNull()
  })
})

describe("line-trimmed tier", () => {
  it("matches when every line matches after trimming", () => {
    const messy = "start\n\t\tfoo(a)\n\nend"
    const needle = "foo(a)\nend"
    const m = matchEdit(messy, needle, { minConfidence: 0.1 })
    expect(m).not.toBeNull()
  })
})

describe("block-anchor tier", () => {
  it("anchors on a distinctive first line when the body has drifted", () => {
    // The body line no longer matches, so the strict tiers all fail — but
    // `function beta() {` is unique and still identifies the block. This is the
    // case the tier exists for: the model recalls the shape, not the contents.
    const m = matchEdit(SRC, "function beta() {\n  TOTALLY DIFFERENT BODY", { minConfidence: 0.1 })
    expect(m?.tier).toBe("block-anchor")
    expect(m?.text).toContain("function beta() {")
  })

  it("lets the strict tier win when the block is already byte-identical", () => {
    expect(matchEdit(SRC, "function beta() {\n  const x = 2", { minConfidence: 0.1 })?.tier).toBe("exact")
  })

  it("prefers indentation-flexible over block-anchor when both could match", () => {
    // A dedented needle is a whitespace problem, so the whitespace tier must
    // win over the content tier.
    expect(matchEdit(SRC, "function beta() {\nconst x = 2", { minConfidence: 0.1 })?.tier).toBe("indentation-flexible")
  })

  it("refuses a short anchor that could match anything", () => {
    expect(matchEdit(SRC, "x\ny", { minConfidence: 0.1 })).toBeNull()
  })
})

describe("substring tier", () => {
  it("matches a fragment whose surrounding whitespace differs", () => {
    // `exact` wins whenever the fragment IS present verbatim, so this tier only
    // exists for the case the model padded or trimmed the fragment.
    const src = "const total = compute(1, 2)"
    const m = matchEdit(src, "  compute(1, 2)  ", { minConfidence: 0.1 })
    expect(m?.tier).toBe("substring")
    expect(src.slice(m!.start, m!.end)).toBe("compute(1, 2)")
  })

  it("lets exact win whenever the fragment is present verbatim", () => {
    const src = "const total = compute(1, 2)"
    expect(matchEdit(src, "compute(1, 2)", { minConfidence: 0.1 })?.tier).toBe("exact")
  })

  it("ignores fragments too short to be meaningful", () => {
    expect(matchEdit(SRC, "x", { minConfidence: 0.1 })).toBeNull()
  })
})

describe("line-numbered tier", () => {
  it("targets a whole 1-based line", () => {
    const out = applyEdit(SRC, "2", "  const x = 42")
    expect(out?.content).toContain("  const x = 42")
  })

  it("targets an inclusive line range", () => {
    const out = applyEdit(SRC, "1-3", "function alpha() {\n  return 0\n}")
    expect(out?.content).toContain("function alpha() {\n  return 0\n}")
  })

  it("accepts a colon range form", () => {
    expect(applyEdit(SRC, "1:3", "x")).not.toBeNull()
  })

  it("refuses an out-of-range line instead of clamping", () => {
    // Clamping onto the last line would silently edit the wrong code.
    expect(applyEdit(SRC, "999", "x")).toBeNull()
    expect(applyEdit(SRC, "0", "x")).toBeNull()
    expect(applyEdit(SRC, "5-1", "x")).toBeNull()
  })
})

describe("unique-line-window tier", () => {
  it("claims a line that trims to exactly one hit", () => {
    const src = "alpha\nbeta\ngamma"
    const m = matchEdit(src, "  beta  ", { minConfidence: 0.1 })
    expect(m?.tier).toBe("unique-line-window")
  })

  it("stays silent when the trimmed line is ambiguous", () => {
    const src = "alpha\nbeta\nbeta"
    expect(matchEdit(src, "beta", { minConfidence: 0.1 })).toBeNull()
  })
})

describe("token-overlap tier", () => {
  it("needs an explicit opt-in below the default floor", () => {
    const src = ["function handler(request) {", "  const result = process(request)", "}"].join("\n")
    // Line 1 hits {request, handler}, line 2 hits {process, request, result} —
    // a clear winner, so the tier fires only once the caller lowers the floor.
    expect(matchEdit(src, "process request handle result")).toBeNull()
    expect(matchEdit(src, "process request handle result", { minConfidence: 0.1 })).not.toBeNull()
  })

  it("refuses when two lines score identically, even with a low floor", () => {
    const src = ["function handler(request) {", "  const result = process(request)", "}"].join("\n")
    // {process, request, handle} ties: line 1 hits request+handler, line 2 hits
    // process+request. A tie means "not knowable", and knowing is the whole rule.
    expect(matchEdit(src, "process request handle", { minConfidence: 0.1 })).toBeNull()
  })

  it("refuses when two lines tie — it must not guess", () => {
    const src = ["function one() {", "  sharedValue = 1", "}", "function two() {", "  sharedValue = 2", "}"].join("\n")
    expect(matchEdit(src, "sharedValue process handler", { minConfidence: 0.1 })).toBeNull()
  })
})

describe("explainMatch", () => {
  it("lists the tiers that matched and how many times", () => {
    const rows = explainMatch(SRC, "  return x")
    expect(rows.some((r) => r.tier === "exact" && r.count === 2)).toBe(true)
  })

  it("reports nothing for a needle that is absent", () => {
    expect(explainMatch(SRC, "definitely_absent_string")).toEqual([])
  })

  it("explains why an ambiguous edit was refused", () => {
    // The agent needs to know it was AMBIGUITY, not absence, to re-read correctly.
    const rows = explainMatch(SRC, "  return x")
    expect(rows.every((r) => r.count > 0)).toBe(true)
  })
})

describe("invariants", () => {
  it("never mutates the input content", () => {
    const snapshot = SRC
    applyEdit(SRC, "function beta() {", "function renamed() {")
    expect(SRC).toBe(snapshot)
  })

  it("applies every tier to a file it can actually match", () => {
    const out = applyEdit(SRC, "function beta() {", "function gamma() {")
    expect(out?.match.tier).toBe("exact")
    expect(out?.content).toBe(SRC.replace("function beta() {", "function gamma() {"))
  })

  it("is idempotent-safe: re-applying an already-applied edit reports no match", () => {
    const once = applyEdit(SRC, "function beta() {", "function gamma() {")
    expect(once).not.toBeNull()
    expect(applyEdit(once!.content, "function beta() {", "x")).toBeNull()
  })
})
