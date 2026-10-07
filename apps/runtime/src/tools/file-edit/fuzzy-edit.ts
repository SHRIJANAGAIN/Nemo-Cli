/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Tiered fuzzy edit matching.
 *
 * A model writes an edit as exact text and the file almost never agrees: the
 * indentation was reindented, a trailing space crept in, the block was reflowed.
 * A literal `indexOf` then fails on a change that is semantically obvious, and
 * the agent falls back to rewriting the whole file — which is where collateral
 * damage comes from.
 *
 * So matching degrades through nine tiers, strictest first, and reports which one
 * succeeded. Two rules make it safe rather than merely convenient:
 *
 *  1. **Ambiguity is a failure, not a guess.** If the old text matches more than
 *     one place, no tier may claim it. Picking the first would silently edit the
 *     wrong function — far worse than refusing and letting the agent re-read.
 *  2. **A looser tier must reconstruct the real indentation**, not just find a
 *     range. Matching `foo()` against an indented copy and then inserting an
 *     unindented replacement produces code that does not parse, which is exactly
 *     the corruption a fuzzy matcher is supposed to prevent.
 */

/** Every tier, strictest first. */
export type EditTier =
  | "exact"
  | "eol-normalised"
  | "indentation-flexible"
  | "line-trimmed"
  | "block-anchor"
  | "substring"
  | "unique-line-window"
  | "line-numbered"
  | "token-overlap"

export interface EditMatch {
  readonly tier: EditTier
  /** Character offsets of the matched region, half-open. */
  readonly start: number
  readonly end: number
  /** The matched text with original whitespace preserved. */
  readonly text: string
  /** 0..1 — higher is safer to apply. Always 1 for `exact`. */
  readonly confidence: number
}

export interface MatchOptions {
  /** Confidence floor; a weaker tier is reported as no match. Default 0.3. */
  readonly minConfidence?: number
  /** Skip the ambiguous-match guard. Only for dry runs; never for applying. */
  readonly allowAmbiguous?: boolean
}

/** CRLF/CR/ LF-insensitive whitespace normalisation for a needle or haystack. */
function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}

/** Collapse a line's leading and trailing whitespace to nothing. */
function trimLine(line: string): string {
  return line.replace(/^[ \t]+|[ \t]+$/g, "")
}

/** The leading whitespace of a line, which a looser match must re-apply. */
function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? ""
}

/** Split preserving line boundaries, so offsets can be rebuilt exactly. */
function linesWithOffsets(content: string): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = []
  let start = 0
  for (const line of content.split("\n")) {
    out.push({ text: line, start, end: start + line.length })
    // +1 for the newline that `split` consumed.
    start += line.length + 1
  }
  return out
}

/** True when `needle` occurs in `haystack` more than once. */
function isAmbiguous(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false
  const first = haystack.indexOf(needle)
  return first === -1 ? false : haystack.indexOf(needle, first + 1) !== -1
}

/** Tier 1: byte-equal. */
function matchExact(content: string, needle: string): EditMatch[] {
  const count = content.split(needle).length - 1
  if (count !== 1) return []
  const start = content.indexOf(needle)
  return [
    {
      tier: "exact",
      start,
      end: start + needle.length,
      text: content.slice(start, start + needle.length),
      confidence: 1,
    },
  ]
}

/** Tier 2: line endings differ, text does not. */
function matchEol(content: string, needle: string): EditMatch[] {
  const flat = normalizeEol(content)
  const flatNeedle = normalizeEol(needle)
  // The mismatch is in whichever side actually carries the `\r` — checking only
  // the needle would miss the real case, where the needle is clean LF.
  if (content.includes("\r") === needle.includes("\r")) return []
  if (flat.split(flatNeedle).length - 1 !== 1) return []
  // Normalised offsets are NOT valid offsets in the original CRLF text, so the
  // range comes from a real match against `content`. Reusing the normalised
  // length would slice the match short by one character per line.
  const source = flatNeedle
    .split("\n")
    .map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\r?\\n")
  const hit = new RegExp(source).exec(content)
  if (!hit) return []
  const at = hit.index
  return [{ tier: "eol-normalised", start: at, end: at + hit[0].length, text: hit[0], confidence: 0.95 }]
}

/**
 * Tier 3: every line matches after trimming.
 *
 * Reports the match with the FILE's own whitespace preserved, so the caller can
 * re-apply it to the replacement.
 */
function matchIndentationFlexible(content: string, needle: string): EditMatch[] {
  const needleLines = needle.split("\n")
  if (needleLines.length < 2) return []
  const hay = linesWithOffsets(content)
  const wanted = needleLines.map(trimLine)
  const out: EditMatch[] = []
  for (let i = 0; i + wanted.length <= hay.length; i++) {
    const window = hay.slice(i, i + wanted.length)
    if (!window.every((l, k) => trimLine(l.text) === wanted[k])) continue
    const start = window[0]?.start ?? 0
    const last = window[window.length - 1]
    const stop = Math.min(content.length, (last?.end ?? start) + 1)
    out.push({ tier: "indentation-flexible", start, end: stop, text: content.slice(start, stop), confidence: 0.85 })
  }
  return out
}

/** Tier 4: same lines, each compared with ALL surrounding whitespace removed. */
function matchLineTrimmed(content: string, needle: string): EditMatch[] {
  const wanted = needle.split("\n").map(trimLine)
  if (wanted.filter((l) => l.length > 0).length < 2) return []
  const hay = linesWithOffsets(content)
  const out: EditMatch[] = []
  // Every hay line whose trimmed form equals the needle's FIRST line is a
  // candidate start — the window must cover the whole file, not just the
  // first `wanted.length` rows, or a re-flowed block deep in a large file
  // could never be found at this tier.
  for (let i = 0; i < hay.length; i++) {
    if (trimLine(hay[i]?.text ?? "") !== wanted[0]) continue
    // The needle's remaining lines may be scattered across the window (edits
    // insert drifted junk between them), but ALL of them must appear, in
    // order. Requiring the full run is what makes the span honest: a partial
    // run would truncate the match to the lines found and apply a replacement
    // that claims to cover more than it did — silent corruption.
    let k = 0
    let last = -1
    const limit = Math.min(hay.length, i + wanted.length * 3)
    for (let j = i; j < limit; j++) {
      if (trimLine(hay[j]?.text ?? "") === wanted[k]) {
        last = j
        k++
        if (k === wanted.length) break
      }
    }
    if (k < wanted.length || last === -1) continue
    const start = hay[i]?.start ?? 0
    const stop = (hay[last]?.end ?? start) + 1
    out.push({ tier: "line-trimmed", start, end: stop, text: content.slice(start, stop), confidence: 0.7 })
  }
  return out
}

/** Tier 5: one distinctive line anchors a window of the same height. */
function matchBlockAnchor(content: string, needle: string): EditMatch[] {
  const wanted = needle
    .split("\n")
    .map(trimLine)
    .filter((l) => l.length > 0)
  if (wanted.length < 2) return []
  const anchor = wanted[0] ?? ""
  // A single common line anchors nothing; require it to be reasonably distinctive.
  if (anchor.length < 8) return []
  const hay = linesWithOffsets(content)
  const anchors = hay.filter((l) => trimLine(l.text) === anchor)
  if (anchors.length !== 1) return []
  const index = hay.findIndex((l) => l === anchors[0])
  const window = hay.slice(index, index + wanted.length)
  if (window.length < wanted.length) return []
  const start = window[0]?.start ?? 0
  const last = window[window.length - 1]
  const stop = (last?.end ?? start) + 1
  return [{ tier: "block-anchor", start, end: stop, text: content.slice(start, stop), confidence: 0.55 }]
}

/** Tier 6: the needle appears inside a line, with the rest of the line kept. */
function matchSubstring(content: string, needle: string): EditMatch[] {
  const trimmed = trimLine(needle)
  if (trimmed.length < 6 || trimmed.includes("\n")) return []
  const out: EditMatch[] = []
  let from = 0
  for (;;) {
    const at = content.indexOf(trimmed, from)
    if (at === -1) break
    out.push({
      tier: "substring",
      start: at,
      end: at + trimmed.length,
      text: content.slice(at, at + trimmed.length),
      confidence: 0.4,
    })
    from = at + trimmed.length
  }
  return out
}

/** Tier 7: a single unique trimmed line, expanded to its whole line. */
function matchUniqueLine(content: string, needle: string): EditMatch[] {
  const wanted = trimLine(needle)
  if (wanted.length === 0 || wanted.includes("\n")) return []
  const hay = linesWithOffsets(content)
  const hits = hay.filter((l) => trimLine(l.text) === wanted)
  if (hits.length !== 1) return []
  const hit = hits[0]
  if (!hit) return []
  return [{ tier: "unique-line-window", start: hit.start, end: hit.end, text: hit.text, confidence: 0.3 }]
}

/**
 * Tier 8: the needle is a bare line NUMBER, so the edit targets that line whole.
 *
 * Line numbers are what a model falls back to when it cannot reproduce the text.
 * Accepting them here keeps the agent from having to rewrite the entire file,
 * which is the outcome this module exists to prevent.
 */
function matchLineNumbered(content: string, needle: string): EditMatch[] {
  const trimmed = trimLine(needle)
  const match = /^(\d+)(?:\s*[-:]\s*(\d+))?$/.exec(trimmed)
  if (!match) return []
  const from = Number(match[1])
  const to = match[2] === undefined ? from : Number(match[2])
  const hay = linesWithOffsets(content)
  if (!Number.isInteger(from) || !Number.isInteger(to)) return []
  // 1-based, inclusive, and must exist — an out-of-range number is a mistake to
  // report, never a reason to clamp onto the last line.
  if (from < 1 || to < from || to > hay.length) return []
  const first = hay[from - 1]
  const last = hay[to - 1]
  if (!first || !last) return []
  const stop = last.end + (to < hay.length ? 1 : 0)
  return [
    { tier: "line-numbered", start: first.start, end: stop, text: content.slice(first.start, stop), confidence: 0.5 },
  ]
}

/** Tier 9: last resort — every identifier-ish token of the needle must appear in order. */
function matchTokenOverlap(content: string, needle: string): EditMatch[] {
  const tokens = [...new Set((needle.match(/[A-Za-z_$][\w$]{3,}|\d+/g) ?? []).map((t) => t.toLowerCase()))]
  if (tokens.length < 2) return []
  const hay = linesWithOffsets(content)
  const scored = hay
    .map((l, i) => ({ i, line: l, hits: tokens.filter((t) => l.text.toLowerCase().includes(t)).length }))
    .filter((e) => e.hits >= Math.min(tokens.length, 2))
  if (scored.length === 0) return []
  // Require a clear winner; a tie means we do not know which line was meant.
  scored.sort((a, b) => b.hits - a.hits)
  const best = scored[0]
  if (!best) return []
  if (scored.length > 1 && scored[1]?.hits === best.hits) return []
  return [{ tier: "token-overlap", start: best.line.start, end: best.line.end, text: best.line.text, confidence: 0.2 }]
}

/**
 * Find the best unambiguous match for `needle`, or null.
 *
 * Tiers are tried strictest-first and the first tier that yields exactly ONE
 * match wins. A tier with zero or many matches does not stop the search — it
 * falls through to the next tier, which is the entire point: strictness is a
 * preference, uniqueness is the requirement.
 */
export function matchEdit(content: string, needle: string, options: MatchOptions = {}): EditMatch | null {
  if (needle.length === 0) return null
  const floor = options.minConfidence ?? 0.3
  // Each tier is a SEPARATE probe. Merging several tiers into one result list
  // would make "one strict match plus one loose match" look like an ambiguity and
  // reject a perfectly valid edit — strictness is a preference, so the tiers must
  // be ranked against each other, not counted against each other.
  const tiers: Array<() => EditMatch[]> = [
    () => matchExact(content, needle),
    () => matchEol(content, needle),
    () => matchIndentationFlexible(content, needle),
    () => matchLineTrimmed(content, needle),
    () => matchBlockAnchor(content, needle),
    () => matchSubstring(content, needle),
    () => matchUniqueLine(content, needle),
    () => matchLineNumbered(content, needle),
    () => matchTokenOverlap(content, needle),
  ]
  for (const run of tiers) {
    const matches = run().filter((m) => m.confidence >= floor)
    if (matches.length === 1) return matches[0] ?? null
    if (matches.length > 1 && options.allowAmbiguous) return matches[0] ?? null
  }
  return null
}

/** The result of an applied edit. */
export interface EditResult {
  readonly content: string
  readonly match: EditMatch
}

/**
 * Apply `needle` → `replacement`.
 *
 * For `indentation-flexible` and `line-trimmed` the replacement is re-indented to
 * the matched region's own leading whitespace. Without that, matching a
 * dedented needle against an indented block yields an unindented replacement and
 * the file stops parsing — a fuzzy matcher that corrupts code is worse than no
 * fuzzy matcher at all.
 */
export function applyEdit(
  content: string,
  needle: string,
  replacement: string,
  options: MatchOptions = {},
): EditResult | null {
  const match = matchEdit(content, needle, options)
  if (!match) return null
  const needsReindent =
    match.tier === "indentation-flexible" || match.tier === "line-trimmed" || match.tier === "block-anchor"
  let inserted = replacement
  if (match.tier === "eol-normalised") {
    // Inserting LF into a CRLF file leaves the file with mixed line endings, which
    // then makes the NEXT diff show every following line as changed.
    inserted = replacement.replace(/\r?\n/g, content.includes("\r\n") ? "\r\n" : "\n")
  }
  if (needsReindent) {
    const regionIndent = indentOf(
      content.slice(
        match.start,
        content.indexOf("\n", match.start) === -1 ? content.length : content.indexOf("\n", match.start),
      ),
    )
    const reline = (line: string, isFirst: boolean): string => {
      if (line.trim().length === 0) return line
      // The first line inherits the region's indent outright; later lines inherit
      // their own original relative indent so nesting is preserved.
      if (isFirst) return `${regionIndent}${line.replace(/^[ \t]+/, "")}`
      const original = needle.split("\n").find((l) => trimLine(l) === trimLine(line))
      const rel = original ? indentOf(original) : ""
      return `${regionIndent}${rel}${line.replace(/^[ \t]+/, "")}`
    }
    // `.map(reline)` would hand the INDEX to `isFirst`, so every line after the
    // first would be treated as the first and lose its relative indent.
    inserted = replacement
      .split("\n")
      .map((line, i) => reline(line, i === 0))
      .join("\n")
  }
  return { content: content.slice(0, match.start) + inserted + content.slice(match.end), match }
}

/** Every tier that matched and how many times, for diagnostics on a refusal. */
export function explainMatch(content: string, needle: string): Array<{ tier: EditTier; count: number }> {
  // Counts must be REAL, not "did it match": an agent re-reading after a refusal
  // needs to see that the text occurs twice, not that it occurred.
  const exactCount = needle.length === 0 ? 0 : content.split(needle).length - 1
  const rows: Array<{ tier: EditTier; count: number }> = []
  if (exactCount > 0) rows.push({ tier: "exact", count: exactCount })
  const rest: Array<[EditTier, () => EditMatch[]]> = [
    ["eol-normalised", () => matchEol(content, needle)],
    ["indentation-flexible", () => matchIndentationFlexible(content, needle)],
    ["line-trimmed", () => matchLineTrimmed(content, needle)],
    ["block-anchor", () => matchBlockAnchor(content, needle)],
    ["substring", () => matchSubstring(content, needle)],
    ["unique-line-window", () => matchUniqueLine(content, needle)],
    ["line-numbered", () => matchLineNumbered(content, needle)],
    ["token-overlap", () => matchTokenOverlap(content, needle)],
  ]
  for (const [tier, run] of rest) {
    const count = run().length
    if (count > 0) rows.push({ tier, count })
  }
  return rows
}

/** True when the needle is ambiguous at some tier, which is a refusal, not an edit. */
export function isAmbiguousEdit(content: string, needle: string): boolean {
  return isAmbiguous(content, needle) || explainMatch(content, needle).some((r) => r.count > 1)
}
