/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Vendored stand-in for `@claude-code/output/utils/intl.js` (the package was
 * never published — registry E404). Grapheme helpers built on Intl.Segmenter,
 * which Node ships natively: vim operators delete/move by GRAPHEME cluster
 * (emoji, combining marks), never by code unit.
 */

const graphemeSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null

/** Something with `.segment(text)` yielding `{ segment, index }`. */
export function getGraphemeSegmenter() {
  if (graphemeSegmenter) return graphemeSegmenter
  // Ancient-runtime fallback: one code point per segment (never happens on
  // supported Node, but keeps the vim layer total).
  return {
    segment(text) {
      const out = []
      let index = 0
      for (const ch of text) {
        out.push({ segment: ch, index })
        index += ch.length
      }
      return out
    },
  }
}

export function firstGrapheme(text) {
  if (!text) return ""
  for (const { segment } of getGraphemeSegmenter().segment(text)) return segment
  return ""
}

export function lastGrapheme(text) {
  if (!text) return ""
  let last = ""
  for (const { segment } of getGraphemeSegmenter().segment(text)) last = segment
  return last
}
