/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { cn } from "./utils.js"

/** `cn` is clsx + tailwind-merge; every test below pins one half of that contract. */
describe("cn", () => {
  it("joins space-separated class strings in argument order", () => {
    expect(cn("p-2", "text-sm")).toBe("p-2 text-sm")
  })

  it("drops falsy entries so conditional class lists collapse cleanly", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b")
    expect(cn(false, null)).toBe("")
  })

  it("returns an empty string when nothing is given", () => {
    expect(cn()).toBe("")
  })

  it("flattens nested arrays including their falsy holes", () => {
    expect(cn(["p-2", ["m-1", null, ["mt-4"]]])).toBe("p-2 m-1 mt-4")
  })

  it("keeps only the active keys of an object map", () => {
    expect(cn({ "text-red": true, "text-blue": false })).toBe("text-red")
  })

  it("lets the last argument win when tailwind utilities conflict", () => {
    expect(cn("p-1", "p-2")).toBe("p-2")
    // font-size utilities carry a line-height, so text-* and leading-* are
    // one conflicting group — the later size replaces both.
    expect(cn("text-sm", ["leading-none", "text-lg"])).toBe("text-lg")
    expect(cn(["p-1", "m-2"], "p-3")).toBe("m-2 p-3")
  })

  it("preserves independent utilities from different groups", () => {
    expect(cn("p-1", "m-2")).toBe("p-1 m-2")
    expect(cn("flex", "rounded-lg", "hover:opacity-50")).toBe("flex rounded-lg hover:opacity-50")
  })
})
