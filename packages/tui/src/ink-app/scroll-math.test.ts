/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The scroll window is `endIdx = messageCount - scrollBack`. These tests pin the
 * three properties App depends on:
 *
 *  1. the window never goes out of range (always ≥1 message rendered);
 *  2. scrolling back never wraps around past either end;
 *  3. growth ANCHORS the window — `endIdx` must not move when rows are appended
 *     while the user is reading history. Losing this is the "history hide nahi
 *     honi chahiye" bug: the window silently slid toward live on every tool
 *     result.
 */

import { describe, expect, it } from "vitest"
import {
  PAGE_STRIDE,
  WHEEL_STRIDE,
  pageScrollOffset,
  scrollOffsetAfterGrowth,
  wheelScrollOffset,
} from "./scroll-math.js"

const endIdx = (messageCount: number, scrollBack: number): number => messageCount - scrollBack

describe("wheelScrollOffset", () => {
  it("moves WHEEL_STRIDE messages per notch", () => {
    expect(wheelScrollOffset("up", 0, 100)).toBe(WHEEL_STRIDE)
    expect(wheelScrollOffset("up", 3, 100)).toBe(6)
    expect(wheelScrollOffset("down", 6, 100)).toBe(3)
    expect(wheelScrollOffset("down", 3, 100)).toBe(0)
  })

  it("clamps at live rather than going negative", () => {
    expect(wheelScrollOffset("down", 0, 100)).toBe(0)
    expect(wheelScrollOffset("down", 2, 100)).toBe(0)
  })

  it("always leaves at least one message in the live frame", () => {
    // Scrolling to the very first message must still render it.
    expect(wheelScrollOffset("up", 98, 100)).toBe(99)
    expect(endIdx(100, wheelScrollOffset("up", 98, 100))).toBe(1)
    expect(endIdx(3, wheelScrollOffset("up", 99, 3))).toBe(1)
  })

  it("survives an empty or single-message transcript", () => {
    expect(wheelScrollOffset("up", 0, 0)).toBe(0)
    expect(wheelScrollOffset("up", 0, 1)).toBe(0)
    expect(wheelScrollOffset("down", 5, 1)).toBe(0)
  })

  it("treats a non-finite offset as live instead of propagating NaN", () => {
    expect(wheelScrollOffset("up", Number.NaN, 50)).toBe(0)
    expect(wheelScrollOffset("down", Number.POSITIVE_INFINITY, 50)).toBe(0)
  })
})

describe("pageScrollOffset", () => {
  it("moves PAGE_STRIDE messages per press", () => {
    expect(pageScrollOffset("up", 0, 200)).toBe(PAGE_STRIDE)
    expect(pageScrollOffset("down", PAGE_STRIDE, 200)).toBe(0)
  })

  it("shares the wheel's clamps", () => {
    expect(pageScrollOffset("up", 195, 200)).toBe(199)
    expect(pageScrollOffset("down", 0, 200)).toBe(0)
  })

  it("pages a long transcript in a few presses", () => {
    let s = 0
    for (let i = 0; i < 3; i++) s = pageScrollOffset("up", s, 1000)
    expect(s).toBe(PAGE_STRIDE * 3)
    expect(endIdx(1000, s)).toBe(970)
  })
})

describe("scrollOffsetAfterGrowth", () => {
  it("keeps endIdx pinned while the user reads history", () => {
    // The load-bearing property: window end must not move on append.
    const before = 10
    const scrollBack = 4
    const endBefore = endIdx(before, scrollBack)
    const after = before + 1
    const next = scrollOffsetAfterGrowth(before, after, scrollBack)
    expect(endIdx(after, next)).toBe(endBefore)
  })

  it("matches a mid-turn burst of tool rows, one-for-one", () => {
    const before = 12
    let s = 5
    const endBefore = endIdx(before, s)
    // Tool rows land two per call mid-turn.
    for (let i = 0; i < 3; i++) {
      const prev = before + i * 2
      s = scrollOffsetAfterGrowth(prev, prev + 2, s)
      expect(endIdx(prev + 2, s), `burst step ${i}`).toBe(endBefore)
    }
  })

  it("leaves a live window (0) live", () => {
    expect(scrollOffsetAfterGrowth(10, 20, 0)).toBe(0)
  })

  it("never re-expands past the first message when the transcript shrinks", () => {
    // /clear or a session swap shrinks the list; the offset must re-clamp into
    // the new range rather than point past the end.
    expect(scrollOffsetAfterGrowth(100, 3, 90)).toBe(2)
    expect(scrollOffsetAfterGrowth(100, 0, 90)).toBe(0)
  })
})
