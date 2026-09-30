/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, it, expect } from "vitest"
import { stringWidth, graphemes, sliceByWidth, padToWidth } from "./stringWidth.js"
import { renderAssistantBubble, stripAnsi } from "../../dialogs.js"
import { visibleLen } from "../../ui/theme.js"

// Built from char codes: a literal control byte in this file corrupts
// tooling that transits the source as raw text.
const ESC = String.fromCharCode(27)
const RED = ESC + "[31m"
const RESET = ESC + "[0m"

describe("stringWidth - Indic/ANSI/emoji display width", () => {
  it("counts ASCII as one column per char", () => {
    expect(stringWidth("hello")).toBe(5)
    expect(stringWidth("")).toBe(0)
    expect(stringWidth(null as unknown as string)).toBe(0)
  })

  it("strips ANSI before measuring", () => {
    expect(stringWidth(RED + "red" + RESET)).toBe(3)
  })

  it("counts wide glyphs as two columns", () => {
    expect(stringWidth("\u4e2d\u6587")).toBe(4)
  })

  it("measures Devanagari BELOW its UTF-16 length (matras live in the base cell)", () => {
    const word = "\u0928\u093f\u0930\u094d\u0926\u0947\u0936" // nirdesh, 7 UTF-16 units
    expect(word.length).toBe(7)
    expect(stringWidth(word)).toBeGreaterThan(0)
    expect(stringWidth(word)).toBeLessThan(word.length)
    // The old per-code-point loop returned exactly `length` for this.
    const phrase = "\u0915\u094b\u0921\u093f\u0902\u0917 \u092e\u0926\u0926" // coding madad
    expect(phrase.length).toBe(10)
    expect(stringWidth(phrase)).toBeLessThan(phrase.length)
  })

  it("agrees with npm string-width (the module Ink wraps Text with)", async () => {
    const npm = (await import("string-width")).default
    const samples = [
      "\u0928\u093f\u0930\u094d\u0926\u0947\u0936",
      "\u092a\u094d\u0930\u0936\u094d\u0928 \u092a\u0942\u091b\u0947\u0902",
      "\u0915\u094b\u0921\u093f\u0902\u0917 \u092e\u0926\u0926",
      "caf\u00e9",
      "\u4e2d\u6587abc",
    ]
    for (const s of samples) {
      expect(stringWidth(s)).toBe(npm(s))
    }
  })

  it("visibleLen (theme) agrees with stringWidth", () => {
    const s = "\u092a\u094d\u0930\u0936\u094d\u0928 \u092a\u0942\u091b\u0947\u0902 \u2014 \u0924\u0915\u0928\u0940"
    expect(visibleLen(s)).toBe(stringWidth(s))
  })
})

describe("graphemes / sliceByWidth - cluster-safe slicing", () => {
  it("never splits a base from its matra", () => {
    // npm measures the cluster "na+i" at 2 columns (its spacing matra adds
    // one), so a 1-column budget fits nothing rather than a partial base;
    // at 2 columns it is exactly the first cluster, matra intact.
    expect(sliceByWidth("\u0928\u093f\u0930\u094d\u0926\u0947\u0936", 1)).toBe("")
    expect(sliceByWidth("\u0928\u093f\u0930\u094d\u0926\u0947\u0936", 2)).toBe("\u0928\u093f")
    expect(sliceByWidth("\u092a\u094d\u0930\u0936\u094d\u0928", 1)).toBe("\u092a\u094d\u0930")
  })

  it("keeps whole clusters on both sides of a cut", () => {
    const s =
      "\u092f\u0939 \u090f\u0915 \u0939\u093f\u0902\u0926\u0940 \u092a\u0902\u0915\u094d\u0924\u093f \u0939\u0948 \u091c\u093f\u0938\u0947 \u0915\u093e\u091f\u093e \u091c\u093e\u090f\u0917\u093e"
    for (const cut of [1, 3, 5, 8]) {
      const head = sliceByWidth(s, cut)
      const tail = s.slice(head.length)
      // Disjoint + exact: re-joining yields the original, nothing dropped.
      expect(head + tail).toBe(s)
      expect(stringWidth(head)).toBeLessThanOrEqual(cut)
    }
  })

  it("respects a zero budget and wide clusters", () => {
    expect(sliceByWidth("\u0928\u092e\u0938\u094d\u0924\u0947", 0)).toBe("")
    // A double-width CJK glyph consumes the whole 2-column budget alone;
    // 4 columns fit exactly two.
    expect(sliceByWidth("\u4e2d\u6587\u6d4b\u8bd5", 2)).toBe("\u4e2d")
    expect(sliceByWidth("\u4e2d\u6587\u6d4b\u8bd5", 4)).toBe("\u4e2d\u6587")
  })

  it("graphemes() groups Indic conjuncts", () => {
    const s = "\u0928\u093f\u0930\u094d\u0926\u0947\u0936"
    expect(graphemes(s).length).toBeLessThan(s.length)
    expect(graphemes(s).join("")).toBe(s)
  })
})

describe("padToWidth - pads to display columns, not UTF-16 units", () => {
  it("brings Hindi text to the target width", () => {
    const word = "\u0928\u092e\u0938\u094d\u0924\u0947"
    const padded = padToWidth(word, 12)
    expect(stringWidth(padded)).toBe(12)
    expect(padded.startsWith(word)).toBe(true)
  })

  it("never truncates", () => {
    expect(padToWidth("already long enough", 4)).toBe("already long enough")
  })
})

describe("renderAssistantBubble - borders align for Hindi too", () => {
  const stripFrame = (r: string): string => {
    let s = stripAnsi(r)
    if (s.startsWith("\u2502  ")) s = s.slice(3)
    if (s.endsWith("  \u2502")) s = s.slice(0, -3)
    return s
  }

  it("every row is exactly `width` columns wide (Hindi body included)", () => {
    const bubble = renderAssistantBubble(
      "\u092e\u093e\u092f \u0915\u0940\u091c\u093f\u090f, \u092e\u0948\u0902 \u0905\u092a\u0928\u0947 \u0906\u0902\u0924\u0930\u093f\u0915 \u0928\u093f\u0930\u094d\u0926\u0947\u0936 \u0938\u093e\u0901\u091d\u093e \u0928\u0939\u0940\u0902 \u0915\u0930 \u0938\u0915\u0924\u093e\u0964 \u0915\u0943\u092a\u092f\u093e \u0915\u094b\u0921\u093f\u0902\u0917 \u0938\u0902\u092c\u0902\u0927\u0940 \u0938\u0939\u093e\u092f\u0924\u093e \u0932\u0947\u0902, \u091c\u0948\u0938\u0947 \u0921\u0940\u092c\u0917 \u0915\u0930\u0928\u093e \u092f\u093e \u0915\u094b\u0921 \u0932\u093f\u0916\u0928\u093e \u0914\u0930 \u0938\u092e\u0940\u0915\u094d\u0937\u093e \u0915\u0930\u0928\u093e\u0964",
    )
    const rows = bubble.split("\n")
    expect(rows.length).toBeGreaterThan(3) // wrapped into multiple rows
    const width = Math.min(88, Math.max(40, (process.stdout.columns || 100) - 8))
    for (const row of rows) {
      expect(stringWidth(row)).toBe(width)
    }
    // Round-trip: stripping the frame yields the wrapped Hindi, unbroken.
    const body = rows.slice(2, -2).map(stripFrame).join(" ").replace(/\s+/g, " ").trim()
    expect(body).toContain("\u0928\u093f\u0930\u094d\u0926\u0947\u0936")
    expect(body).toContain("\u0938\u092e\u0940\u0915\u094d\u0937\u093e")
  })
})
