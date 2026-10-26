/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { parseUnifiedDiff } from "./diff-render.js"

describe("parseUnifiedDiff hunk bodies", () => {
  it("does not mistake body lines starting with ++ for +++ / --- file headers", () => {
    // A diff line that ADDS content starting with "++" is rendered as
    // "+++ …" — indistinguishable from the b-file header at a glance. The
    // header branch ran for every line, so such a body line overwrote the
    // file path, dropped the added line, and under-counted `adds`.
    const diff = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,2 +1,3 @@",
      " context",
      "+plain();",
      "+++ this-line-starts-with-two-plus",
    ].join("\n")
    const files = parseUnifiedDiff(diff)
    expect(files[0]?.path).toBe("f.txt") // RED: "this-line-starts-with-two-plus"
    const texts = (files[0]?.hunks[0]?.lines ?? []).map((l) => l.text)
    // The added line keeps its diff marker: text is "++ this-line-…".
    expect(texts.some((t) => t.includes("this-line-starts-with-two-plus"))).toBe(true) // RED: line silently dropped
    expect(files[0]?.adds).toBe(2) // RED: 1 (the ++-line never counted)
  })
})