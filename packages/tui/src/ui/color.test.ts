/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { blend, isLight, perceptualDistance } from "./color.js"
import type { Rgb } from "./color.js"

describe("isLight", () => {
  it("uses the YIQ luminance threshold at 128 (exclusive)", () => {
    expect(isLight([255, 255, 255])).toBe(true)
    expect(isLight([0, 0, 0])).toBe(false)
    expect(isLight([128, 128, 128])).toBe(false) // y === 128 is not > 128
    expect(isLight([129, 129, 129])).toBe(true)
  })

  it("weights green most heavily", () => {
    expect(isLight([0, 255, 0])).toBe(true)
    expect(isLight([0, 0, 255])).toBe(false)
    expect(isLight([255, 0, 0])).toBe(false)
  })
})

describe("blend", () => {
  it("interpolates each channel by alpha", () => {
    expect(blend([255, 0, 0], [0, 0, 0], 0.5)).toEqual([127.5, 0, 0])
    expect(blend([0, 100, 200], [200, 100, 0], 0.25)).toEqual([150, 100, 50])
  })

  it("returns the foreground at alpha 1 and the background at alpha 0", () => {
    const fg: Rgb = [10, 20, 30]
    const bg: Rgb = [40, 50, 60]
    expect(blend(fg, bg, 1)).toEqual(fg)
    expect(blend(fg, bg, 0)).toEqual(bg)
  })
})

describe("perceptualDistance", () => {
  const black: Rgb = [0, 0, 0]
  const white: Rgb = [255, 255, 255]
  const red: Rgb = [255, 0, 0]
  const blue: Rgb = [0, 0, 255]

  it("is zero for identical colors", () => {
    expect(perceptualDistance(black, black)).toBe(0)
    expect(perceptualDistance(red, red)).toBe(0)
  })

  it("is symmetric", () => {
    expect(perceptualDistance(red, blue)).toBe(perceptualDistance(blue, red))
    expect(perceptualDistance(black, white)).toBe(perceptualDistance(white, black))
  })

  it("measures black-to-white at roughly 100 CIE76 units", () => {
    expect(perceptualDistance(black, white)).toBeCloseTo(100, 2)
  })

  it("ranks near pairs below far pairs", () => {
    const near = perceptualDistance(black, [10, 10, 10])
    const far = perceptualDistance(black, white)
    expect(near).toBeGreaterThan(0)
    expect(near).toBeLessThan(far)
  })
})
