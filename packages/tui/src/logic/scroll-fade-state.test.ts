/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { readScrollFadeState } from "./scroll-fade-state.js"

interface Viewport {
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
}

/** The hook reads four scroll metrics off an element; supply them directly. */
const viewport = (over: Viewport): HTMLElement => ({ ...over }) as unknown as HTMLElement

describe("readScrollFadeState", () => {
  it("shows no fades when there is no horizontal overflow", () => {
    expect(readScrollFadeState(viewport({ scrollLeft: 0, scrollWidth: 100, clientWidth: 100 }))).toEqual({
      left: false,
      right: false,
    })
    // Shrink-to-fit content (scrollWidth below clientWidth) never fades either.
    expect(readScrollFadeState(viewport({ scrollLeft: 0, scrollWidth: 40, clientWidth: 100 }))).toEqual({
      left: false,
      right: false,
    })
  })

  it("fades only the right edge while an overflowing row is at rest", () => {
    expect(readScrollFadeState(viewport({ scrollLeft: 0, scrollWidth: 300, clientWidth: 100 }))).toEqual({
      left: false,
      right: true,
    })
  })

  it("fades both edges when scrolled into the middle", () => {
    expect(readScrollFadeState(viewport({ scrollLeft: 100, scrollWidth: 300, clientWidth: 100 }))).toEqual({
      left: true,
      right: true,
    })
  })

  it("clears the right fade once scrolled flush to the end", () => {
    expect(readScrollFadeState(viewport({ scrollLeft: 200, scrollWidth: 300, clientWidth: 100 }))).toEqual({
      left: true,
      right: false,
    })
  })

  it("keeps a 1px dead zone at both edges (margin = 1)", () => {
    // left: needs MORE than 1px of scrollLeft…
    expect(readScrollFadeState(viewport({ scrollLeft: 1, scrollWidth: 300, clientWidth: 100 })).left).toBe(false)
    expect(readScrollFadeState(viewport({ scrollLeft: 2, scrollWidth: 300, clientWidth: 100 })).left).toBe(true)
    // right: 2px of content still hidden fades the edge, 1px does not.
    expect(readScrollFadeState(viewport({ scrollLeft: 198, scrollWidth: 300, clientWidth: 100 })).right).toBe(true)
    expect(readScrollFadeState(viewport({ scrollLeft: 199, scrollWidth: 300, clientWidth: 100 })).right).toBe(false)
  })
})
