/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { normalizeStairIndent } from "./text-format.js"

describe("normalizeStairIndent", () => {
  it("strips exactly one leading space from hard-broken prose lines (model echo)", () => {
    const stair =
      'We are in plan mode. The user said "HI". We need to respond appropriately.\n' +
      " Since we are in plan mode, we cannot make changes.\n" +
      " However the user just said HI."
    expect(normalizeStairIndent(stair)).toBe(
      'We are in plan mode. The user said "HI". We need to respond appropriately.\n' +
        "Since we are in plan mode, we cannot make changes.\n" +
        "However the user just said HI.",
    )
  })

  it("keeps first line, deeper indents, tabs, and single-line text untouched", () => {
    const text = "  leading-two-spaces-first-line\n    code block line\n\t tabbed line\n last line"
    expect(normalizeStairIndent(text)).toBe(
      "  leading-two-spaces-first-line\n    code block line\n\t tabbed line\nlast line",
    )
    const single = " no newline at all"
    expect(normalizeStairIndent(single)).toBe(single)
  })

  it("leaves empty and whitespace-only continuation lines alone", () => {
    const text = "para\n\n \nnext"
    expect(normalizeStairIndent(text)).toBe("para\n\n\nnext")
  })

  it("leaves fenced code blocks (diffs, diagrams) byte-identical", () => {
    const text =
      "here is the diff:\n" +
      "```diff\n" +
      "--- a\n" +
      "+++ b\n" +
      "@@ -1 +1 @@\n" +
      " context\n" +
      "-gone\n" +
      "+here\n" +
      "```\n" +
      " trailing prose still fixed"
    expect(normalizeStairIndent(text)).toBe(
      "here is the diff:\n" +
        "```diff\n" +
        "--- a\n" +
        "+++ b\n" +
        "@@ -1 +1 @@\n" +
        " context\n" +
        "-gone\n" +
        "+here\n" +
        "```\n" +
        "trailing prose still fixed",
    )
  })

  it("treats an unclosed fence as code to the end (preservation wins)", () => {
    const text = "intro:\n```\n code\n more"
    expect(normalizeStairIndent(text)).toBe(text)
  })
})
