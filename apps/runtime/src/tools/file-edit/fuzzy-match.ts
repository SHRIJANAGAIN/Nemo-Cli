/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/** Progressive old_string matching for edit_file (apply_patch port).
 *
 *  Models constantly miss byte-exact matches on indentation or trailing
 *  whitespace, and opencode's patch pipeline survives this with tiered
 *  passes. Same idea here, bounded and honest: exact first; only when
 *  exact finds ZERO matches do the looser passes run, and a loose match
 *  is applied only when it is UNIQUE (multiple loose matches still
 *  error — silently picking one would corrupt files).
 */

export type FuzzyPass = "exact" | "trimEnd" | "trim" | "unicode"

export interface FuzzySpan {
  /** Char offset of the match start in the ORIGINAL text. */
  start: number
  /** Char offset of the match end (exclusive) in the ORIGINAL text. */
  end: number
  /** The loosest pass that matched. */
  pass: FuzzyPass
}

const SMART_PUNCT: Array<[RegExp, string]> = [
  [/[\u2018\u2019\u201A\u201B]/g, "'"],
  [/[\u201C\u201D\u201E\u201F]/g, '"'],
  [/[\u2013\u2014\u2015]/g, "-"],
  [/\u2026/g, "..."],
  [/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " "],
]

function normalizeUnicode(line: string): string {
  let out = line.normalize("NFKC")
  for (const [re, rep] of SMART_PUNCT) out = out.replace(re, rep)
  return out
}

const PASS_FNS: Record<Exclude<FuzzyPass, "exact">, (line: string) => string> = {
  trimEnd: (line) => line.replace(/[ \t\r]+$/, ""),
  trim: (line) => line.trim(),
  unicode: (line) => normalizeUnicode(line.trim()),
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/)
}

/** Line offsets in the original text: offsets[i] = char offset where line i starts. */
function lineOffsets(text: string): number[] {
  const offsets: number[] = [0]
  const re = /\r?\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) offsets.push(m.index + m[0].length)
  return offsets
}

/** Find every span where oldStr occurs under pass `pass`. */
function findPassSpans(original: string, oldStr: string, pass: FuzzyPass): FuzzySpan[] {
  const norm = pass === "exact" ? (s: string): string => s : PASS_FNS[pass]
  const origLines = splitLines(original)
  const oldLines = splitLines(oldStr)
  if (oldLines.length === 0) return []
  const normOrig = origLines.map(norm)
  const normOld = oldLines.map(norm)
  // An all-empty needle matches everywhere — refuse (caller treats as miss).
  if (normOld.every((l) => l.length === 0)) return []
  const offsets = lineOffsets(original)
  const spans: FuzzySpan[] = []
  for (let i = 0; i + normOld.length <= normOrig.length; i++) {
    let ok = true
    for (let j = 0; j < normOld.length; j++) {
      if (normOrig[i + j] !== normOld[j]) {
        ok = false
        break
      }
    }
    if (!ok) continue
    // Span covers the matched lines' CONTENT only (no line breaks): the
    // caller splices original.slice(0, start) + newStr + original.slice(end),
    // so swallowing a trailing break would glue the next line onto newStr.
    // end = start of the next line minus this line's break length; at EOF
    // the span runs to the end of the text.
    const endLine = i + normOld.length - 1
    const lineStart = offsets[i] ?? 0
    const nextStart = offsets[endLine + 1]
    const breakLen =
      nextStart === undefined ? 0 : nextStart - (offsets[endLine] ?? 0) - (origLines[endLine] ?? "").length
    spans.push({
      start: lineStart,
      end: (nextStart ?? original.length) - breakLen,
      pass,
    })
  }
  return spans
}

/** Progressive search: exact → trimEnd → trim → unicode. Returns the
 *  spans of the FIRST pass that matches anything (possibly empty). */
export function findOldStringSpans(original: string, oldStr: string): FuzzySpan[] {
  if (!oldStr) return []
  const passes: FuzzyPass[] = ["exact", "trimEnd", "trim", "unicode"]
  for (const pass of passes) {
    const spans = findPassSpans(original, oldStr, pass)
    if (spans.length > 0) return spans
  }
  return []
}
