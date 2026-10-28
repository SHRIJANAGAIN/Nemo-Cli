/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/** waveLevels: hot spot travels one char per frame and wraps around. */

import { describe, expect, it } from "vitest"
import { waveLevels } from "./spinner.js"

describe("waveLevels", () => {
  it("walks a hot spot one char per frame", () => {
    expect(waveLevels(4, 0)).toEqual([2, 1, 0, 0])
    expect(waveLevels(4, 1)).toEqual([1, 2, 1, 0])
    expect(waveLevels(4, 2)).toEqual([0, 1, 2, 1])
  })

  it("wraps the halo around the label edges", () => {
    // frame 5 of wavelength 6: hot sits past the end, halo re-enters at 0.
    expect(waveLevels(4, 5)).toEqual([1, 0, 0, 0])
    expect(waveLevels(4, 6)).toEqual([2, 1, 0, 0])
  })

  it("is empty for empty labels and bad wavelengths", () => {
    expect(waveLevels(0, 3)).toEqual([])
    expect(waveLevels(4, 0, 0)).toEqual([])
    expect(waveLevels(4, 0, -2)).toEqual([])
  })

  it("honors a custom wavelength", () => {
    expect(waveLevels(6, 0, 3)).toEqual([2, 1, 1, 2, 1, 1])
  })
})
