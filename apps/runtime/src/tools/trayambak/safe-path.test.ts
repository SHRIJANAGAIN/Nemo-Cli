/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { safePathSegment } from "./safe-path.js"

/**
 * Path-segment guard for model-supplied file names (inbox ids, rule files,
 * agent profiles). The regression this locks: `path.join(dir, seg)` with a
 * `..`-or-separator-bearing `seg` silently normalizes OUT of `dir`, so the
 * refusal must happen on the segment before any fs call.
 */
describe("safePathSegment", () => {
  it("returns plain file-name segments unchanged", () => {
    const ok = [
      "agent-1",
      "My.Agent_v2",
      "name with spaces",
      "code-reviewer",
      "0",
      "a".repeat(128),
      "NULITE",
      "COMPUTER.md",
      "..hidden",
      "...but-not-dotdot",
    ]
    for (const value of ok) expect(safePathSegment(value)).toBe(value)
  })

  it("refuses traversal, separators, control characters, and reserved names", () => {
    const bad = [
      "",
      "..",
      ".",
      "a/b",
      "a\\b",
      "..\\..\\evil",
      "../../evil",
      "C:\\Windows\\evil",
      "/etc/passwd",
      "a\u0000b",
      "line\nbreak",
      "carriage\rreturn",
      "trailing.",
      "trailing ",
      "a".repeat(129),
      "CON",
      "con.md",
      "NUL",
      "com1.txt",
      "lpt9",
      "PRN",
      "aux",
    ]
    for (const value of bad) expect(safePathSegment(value)).toBeNull()
  })

  it("refuses non-string inputs", () => {
    expect(safePathSegment(undefined)).toBeNull()
    expect(safePathSegment(null)).toBeNull()
    expect(safePathSegment(42)).toBeNull()
    expect(safePathSegment({ name: "x" })).toBeNull()
  })
})
