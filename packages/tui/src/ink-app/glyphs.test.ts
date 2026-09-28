/* Copyright 2026 SKT AI LABS PRIVATE LIMITED.
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
  process.env.TRAYAMBAK_GLYPHS = "unicode"
  resetGlyphCache()
})

describe("glyphs", () => {
  it("defaults to unicode; ascii only on explicit opt-out", () => {
    delete process.env.TRAYAMBAK_GLYPHS
    resetGlyphCache()
    expect(glyphSet()).toBe("unicode")
    process.env.TRAYAMBAK_GLYPHS = "ascii"
    resetGlyphCache()
    expect(glyphSet()).toBe("ascii")
  })

  it("every glyph is width-1 in both sets", () => {
    for (const set of ["unicode", "ascii"] as const) {
      process.env.TRAYAMBAK_GLYPHS = set
      resetGlyphCache()
      for (const name of NAMES) {
        expect(stringWidth(g(name))).toBe(1)
      }
    }
  })

  it("ascii set has no non-ASCII bytes", () => {
    process.env.TRAYAMBAK_GLYPHS = "ascii"
    resetGlyphCache()
    for (const name of NAMES) {
      expect(/^[\x20-\x7e]$/.test(g(name))).toBe(true)
    }
    for (const f of spinnerFrames()) {
      expect(/^[\x20-\x7e]$/.test(f)).toBe(true)
    }
  })

  it("unicode set keeps the established marks", () => {
    process.env.TRAYAMBAK_GLYPHS = "unicode"
    resetGlyphCache()
    expect(g("dot")).toBe("●")
    expect(g("ok")).toBe("✓")
    expect(g("fail")).toBe("✗")
    expect(g("prompt")).toBe("❯")
  })
})
