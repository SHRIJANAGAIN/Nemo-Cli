/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"

import { pageScrollOffset, scrollOffsetAfterGrowth, wheelScrollOffset } from "./scroll-math.js"

describe("wheelScrollOffset", () => {
  it("moves 3 messages per notch and clamps at live (0) / the first message", () => {
    expect(wheelScrollOffset("up", 0, 40)).toBe(3)
    expect(wheelScrollOffset("up", 3, 40)).toBe(6)
    expect(wheelScrollOffset("up", 38, 40)).toBe(39) // max = count−1 → endIdx 1 → message 0 in frame
    expect(wheelScrollOffset("up", 39, 40)).toBe(39)
    expect(wheelScrollOffset("down", 5, 40)).toBe(2)
    expect(wheelScrollOffset("down", 2, 40)).toBe(0)
    expect(wheelScrollOffset("down", 0, 40)).toBe(0)
  })

  it("never scrolls past a lone/empty transcript (stays live)", () => {
    expect(wheelScrollOffset("up", 0, 1)).toBe(0)
    expect(wheelScrollOffset("up", 0, 0)).toBe(0)
  })
})

describe("pageScrollOffset (PageUp/PageDown stride)", () => {
  it("jumps 10 messages per press and clamps exactly like the wheel", () => {
    expect(pageScrollOffset("up", 0, 40)).toBe(10)
    expect(pageScrollOffset("up", 10, 40)).toBe(20)
    expect(pageScrollOffset("up", 35, 40)).toBe(39) // same max = count−1 → message 0 in frame
    expect(pageScrollOffset("up", 39, 40)).toBe(39)
    expect(pageScrollOffset("down", 25, 40)).toBe(15)
    expect(pageScrollOffset("down", 7, 40)).toBe(0) // clamps at live, never negative
    expect(pageScrollOffset("down", 0, 40)).toBe(0)
  })

  it("never pages past a lone/empty transcript (stays live)", () => {
    expect(pageScrollOffset("up", 0, 1)).toBe(0)
    expect(pageScrollOffset("up", 0, 0)).toBe(0)
  })
})

describe("scrollOffsetAfterGrowth (anchored reading position)", () => {
  it("pins the window END: +N appended rows → +N offset (endIdx unchanged)", () => {
    // endIdx 40−5=35; ten tool rows append mid-turn → offset 15, still 35:
    expect(scrollOffsetAfterGrowth(40, 50, 5)).toBe(15)
    expect(50 - scrollOffsetAfterGrowth(40, 50, 5)).toBe(40 - 5)
  })

  it("keeps the FIRST message readable while the transcript grows", () => {
    expect(scrollOffsetAfterGrowth(40, 50, 39)).toBe(49) // endIdx 1 on both sides
  })

  it("leaves the LIVE window (0) and shrinks alone", () => {
    expect(scrollOffsetAfterGrowth(40, 50, 0)).toBe(0) // live follows the turn
    expect(scrollOffsetAfterGrowth(50, 40, 8)).toBe(8) // shrink → the epoch reset owns it
  })
})
