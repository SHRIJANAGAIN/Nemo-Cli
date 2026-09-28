/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Terminal display width — delegates to npm `string-width`, the SAME module
 * Ink wraps and measures Text with. One source of truth: whatever Ink thinks
 * a row occupies is what the app's manual boxes/pads assume, so borders,
 * footers and bubbles cannot drift from the rendered text.
 *
 * The old implementations (per-code-point loops, `String.length`) over-counted
 * Indic text: Devanagari matras/virama are separate code points but sit inside
 * the base glyph's cell — "निर्देश" is 7 UTF-16 units but ~4 columns — so
 * every pad came out short (right borders slid left) and wrap/clip cut words
 * apart.
 *
 * Slicing/animation helpers iterate GRAPHEME CLUSTERS (Intl.Segmenter, UAX #29)
 * so a cut can never land between a base consonant and its matra.
 */
import npmStringWidth from "string-width"

/** CSI sequences (ESC [ ... letter) — built without a literal control byte. */
const ANSI_SPLIT = new RegExp("(" + String.fromCharCode(27) + "\\[[0-9;]*[a-zA-Z])", "g")

let segmenter: Intl.Segmenter | undefined

/** Split into grapheme clusters — the only safe boundaries for slicing. */
export function graphemes(str: string): string[] {
  if (!segmenter) segmenter = new Intl.Segmenter("en", { granularity: "grapheme" })
  const out: string[] = []
  for (const { segment } of segmenter.segment(str)) out.push(segment)
  return out
}

export function stringWidth(str: string): number {
  if (str === null || str === undefined) return 0
  if (typeof str !== "string" || str.length === 0) return 0
  try {
    // string-width strips ANSI itself and measures per grapheme cluster.
    return npmStringWidth(str)
  } catch {
    // Defensive fallback (e.g. lone surrogates from a broken stream):
    // count code points after a minimal ANSI strip — never crash layout.
    const stripped = str.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[a-zA-Z]", "g"), "")
    return [...stripped].length
  }
}

/** Clip to at most `max` display columns without splitting a cluster.
 *  ANSI sequences pass through untouched (width 0) so styling survives. */
export function sliceByWidth(str: string, max: number): string {
  if (max <= 0) return ""
  let out = ""
  let used = 0
  for (const part of str.split(ANSI_SPLIT)) {
    if (!part) continue
    if (part.charCodeAt(0) === 27) {
      out += part // ANSI: advances no cell
      continue
    }
    for (const g of graphemes(part)) {
      const w = stringWidth(g)
      if (used + w > max) return out
      out += g
      used += w
    }
  }
  return out
}

/** Pad with spaces to `width` display columns (String.padEnd counts UTF-16
 *  units, which mis-pads any text with combining marks or wide glyphs). */
export function padToWidth(str: string, width: number, fill = " "): string {
  const deficit = width - stringWidth(str)
  return deficit > 0 ? str + fill.repeat(deficit) : str
}

export default stringWidth
