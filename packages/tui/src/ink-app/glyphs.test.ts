/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, afterEach } from "vitest"
import stringWidth from "string-width"
import { g, glyphSet, resetGlyphCache, spinnerFrames, type GlyphName } from "./glyphs.js"

const NAMES: GlyphName[] = [
  "dot",
  "ring",
  "spinnerDot",
  "ok",
  "fail",
  "warn",
  "star",
  "caret",
  "prompt",
  "picker",
  "bullet",
  "caretDown",
  "caretUp",
]

afterEach(() => {
  process.env.NEMO_GLYPHS = "unicode"
  delete process.env.NEMO_SPINNER
  resetGlyphCache()
})

describe("glyphs", () => {
  it("defaults to unicode; ascii only on explicit opt-out", () => {
    delete process.env.NEMO_GLYPHS
    resetGlyphCache()
    expect(glyphSet()).toBe("unicode")
    process.env.NEMO_GLYPHS = "ascii"
    resetGlyphCache()
    expect(glyphSet()).toBe("ascii")
  })

  it("every glyph is width-1 in both sets", () => {
    for (const set of ["unicode", "ascii"] as const) {
      process.env.NEMO_GLYPHS = set
      resetGlyphCache()
      for (const name of NAMES) {
        expect(stringWidth(g(name))).toBe(1)
      }
    }
  })

  it("ascii set has no non-ASCII bytes", () => {
    process.env.NEMO_GLYPHS = "ascii"
    resetGlyphCache()
    for (const name of NAMES) {
      expect(/^[\x20-\x7e]$/.test(g(name))).toBe(true)
    }
    for (const f of spinnerFrames()) {
      expect(/^[\x20-\x7e]$/.test(f)).toBe(true)
    }
  })

  it("unicode set keeps the established marks", () => {
    process.env.NEMO_GLYPHS = "unicode"
    resetGlyphCache()
    expect(g("dot")).toBe("●")
    expect(g("ok")).toBe("✓")
    expect(g("fail")).toBe("✗")
    expect(g("prompt")).toBe("❯")
  })

  it("NEMO_SPINNER picks a preset, in the active glyph coverage", () => {
    process.env.NEMO_GLYPHS = "unicode"
    process.env.NEMO_SPINNER = "line"
    resetGlyphCache()
    expect(spinnerFrames()).toEqual(["─", "╲", "│", "╱"])
    process.env.NEMO_GLYPHS = "ascii"
    resetGlyphCache()
    expect(spinnerFrames()).toEqual(["-", "\\", "|", "/"])
  })

  it("an unknown spinner name keeps the braille default", () => {
    process.env.NEMO_GLYPHS = "unicode"
    process.env.NEMO_SPINNER = "not-a-spinner"
    resetGlyphCache()
    expect(spinnerFrames()).toEqual(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"])
  })

  it("hands out a copy, so a widget cannot corrupt the table", () => {
    process.env.NEMO_GLYPHS = "unicode"
    resetGlyphCache()
    spinnerFrames().length = 1
    resetGlyphCache()
    expect(spinnerFrames()).toHaveLength(10)
  })
})
