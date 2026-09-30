/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Vendored stand-in for `@claude-code/repl/Cursor.js`.
 *
 * The trayambak-ink fork imports this package on five paths (vim motions /
 * operators / text objects, the search hook, the API foundation test), but
 * the package was never published to npm — the registry answers 404 — so the
 * fork could never resolve it. This file implements exactly the surface the
 * fork consumes:
 *
 *   - `Cursor` — an IMMEDIATE text cursor: `new Cursor(text, offset)` and
 *     `Cursor.fromText(text, columns, offset)`. Every motion returns a new
 *     cursor; `equals()` powers the early-break in vim/motions.ts
 *     (`if (next.equals(result)) break`). Returns the `{ cursor, killed }`
 *     shape (self-referential, non-enumerable) from the kill-style deletes
 *     because the search hook destructures `deleteWordBefore`/
 *     `deleteToLineStart`/`deleteToLineEnd` as tuples while using
 *     `deleteWordAfter` as a plain cursor.
 *   - kill-ring module state — `pushToKillRing(text, "prepend"|"append")`,
 *     `getLastKill()`, `recordYank(start, length)`,
 *     `updateYankLength(length)`, `yankPop()`,
 *     `resetKillAccumulation()`, `resetYankState()`.
 *   - vim character classes — `isVimWordChar` / `isVimWhitespace` /
 *     `isVimPunctuation`.
 *
 * Semantics follow vim's documented word/line motions and Emacs-style kill
 * accumulation (consecutive backward kills prepend, forward kills append —
 * `ctrl+u` twice then yank restores original order). Display-width wrapping
 * is NOT modeled: `columns` is accepted for API compatibility and every
 * line motion works on logical lines (the fork's prompt is single-line, and
 * its test suite pins the behavior that matters).
 */

// ---------------------------------------------------------------------------
// vim character classes
// ---------------------------------------------------------------------------

/** Word char: letter, number or underscore (vim's `\w`-class, unicode-aware). */
export const isVimWordChar = (ch) => typeof ch === "string" && ch.length > 0 && /[\p{L}\p{N}_]/u.test(ch)

export const isVimWhitespace = (ch) => typeof ch === "string" && /\s/.test(ch)

/** Non-blank, non-word: punctuation run (vim's other word class). */
export const isVimPunctuation = (ch) => typeof ch === "string" && ch.length > 0 && !isVimWordChar(ch) && !isVimWhitespace(ch)

/** Word motions: {ws, word, punct} — three classes. */
const wordClass = (ch) => {
  if (isVimWhitespace(ch)) return 0
  return isVimWordChar(ch) ? 1 : 2
}
/** WORD motions: {ws, rest} — whitespace-separated. */
const WORDClass = (ch) => (isVimWhitespace(ch) ? 0 : 1)

const WS = 0

// ---------------------------------------------------------------------------
// line helpers (logical lines; no display-wrap modeling)
// ---------------------------------------------------------------------------

const lineStartOf = (text, offset) => {
  const i = text.lastIndexOf("\n", Math.max(0, offset) - 1)
  return i < 0 ? 0 : i + 1
}

const lineEndOf = (text, offset) => {
  const i = text.indexOf("\n", offset)
  return i < 0 ? text.length : i
}

const firstNonBlank = (text, from, limit) => {
  let i = from
  while (i < limit && isVimWhitespace(text[i])) i++
  return i < limit ? i : from
}

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n)

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

export class Cursor {
  constructor(text, offset = 0) {
    this.text = typeof text === "string" ? text : ""
    this.offset = clamp(Math.trunc(Number(offset)) || 0, 0, this.text.length)
  }

  /**
   * @param text full buffer
   * @param columns display width (reserved: upstream measured wrapped lines
   *   here; this vendored copy keeps it for signature compatibility)
   * @param offset caret offset
   */
  static fromText(text, columns, offset = 0) {
    void columns
    return new Cursor(text, offset)
  }

  /** Display-measured text (no wrap modeling → the text itself). */
  get measuredText() {
    return this.text
  }

  equals(other) {
    return other != null && other.offset === this.offset && other.text === this.text
  }

  isAtEnd() {
    return this.offset >= this.text.length
  }

  // -- single-line char motions --------------------------------------------

  left() {
    if (this.offset <= lineStartOf(this.text, this.offset)) return this
    return new Cursor(this.text, this.offset - 1)
  }

  right() {
    if (this.offset >= lineEndOf(this.text, this.offset)) return this
    return new Cursor(this.text, this.offset + 1)
  }

  // -- line motions ---------------------------------------------------------

  upLogicalLine() {
    const start = lineStartOf(this.text, this.offset)
    if (start === 0) return this
    const col = this.offset - start
    const prevEnd = start - 1 // the "\n"
    const prevStart = lineStartOf(this.text, prevEnd)
    return new Cursor(this.text, prevStart + clamp(col, 0, prevEnd - prevStart))
  }

  downLogicalLine() {
    const end = lineEndOf(this.text, this.offset)
    if (end >= this.text.length) return this
    const col = this.offset - lineStartOf(this.text, this.offset)
    const nextStart = end + 1
    const nextEnd = lineEndOf(this.text, nextStart)
    return new Cursor(this.text, nextStart + clamp(col, 0, nextEnd - nextStart))
  }

  // Display-line variants: without wrap modeling these track logical lines.
  up() {
    return this.upLogicalLine()
  }

  down() {
    return this.downLogicalLine()
  }

  startOfLogicalLine() {
    return new Cursor(this.text, lineStartOf(this.text, this.offset))
  }

  endOfLogicalLine() {
    return new Cursor(this.text, lineEndOf(this.text, this.offset))
  }

  firstNonBlankInLogicalLine() {
    const start = lineStartOf(this.text, this.offset)
    return new Cursor(this.text, firstNonBlank(this.text, start, lineEndOf(this.text, start)))
  }

  startOfFirstLine() {
    return new Cursor(this.text, 0)
  }

  startOfLastLine() {
    return new Cursor(this.text, lineStartOf(this.text, this.text.length))
  }

  /** G with count (1-based): start of line `count`, clamped to the last. */
  goToLine(count) {
    const wanted = clamp(Math.trunc(count) || 1, 1, Number.MAX_SAFE_INTEGER)
    let pos = 0
    for (let line = 1; line < wanted; line++) {
      const nl = this.text.indexOf("\n", pos)
      if (nl < 0) break
      pos = nl + 1
    }
    return new Cursor(this.text, pos)
  }

  // -- word motions ---------------------------------------------------------

  /** vim `w` / `W`: leave the current class run, skip whitespace, land on the next run start. */
  nextWordLike(cls) {
    const t = this.text
    let i = this.offset
    if (i >= t.length) return this
    const c = cls(t[i])
    while (i < t.length && cls(t[i]) === c) i++
    if (c !== WS) {
      while (i < t.length && cls(t[i]) === WS) i++
    }
    return new Cursor(t, Math.min(i, t.length))
  }

  /** vim `b` / `B`: skip whitespace backwards, then the run, land on its start. */
  prevWordLike(cls) {
    const t = this.text
    let i = this.offset
    if (i === 0) return this
    while (i > 0 && cls(t[i - 1]) === WS) i--
    if (i === 0) return new Cursor(t, 0)
    const c = cls(t[i - 1])
    while (i > 0 && cls(t[i - 1]) === c) i--
    return new Cursor(t, i)
  }

  /** vim `e` / `E`: end of the current word, or of the next one when already at an end. */
  endOfWordLike(cls) {
    const t = this.text
    const at = this.offset
    if (at >= t.length) return this
    if (cls(t[at]) !== WS) {
      const c = cls(t[at])
      let j = at
      while (j + 1 < t.length && cls(t[j + 1]) === c) j++
      if (j > at) return new Cursor(t, j)
    }
    let k = at
    while (k < t.length && cls(t[k]) === WS) k++
    if (k >= t.length) return this
    const c2 = cls(t[k])
    while (k + 1 < t.length && cls(t[k + 1]) === c2) k++
    return new Cursor(t, k)
  }

  nextVimWord() {
    return this.nextWordLike(wordClass)
  }

  prevVimWord() {
    return this.prevWordLike(wordClass)
  }

  endOfVimWord() {
    return this.endOfWordLike(wordClass)
  }

  nextWORD() {
    return this.nextWordLike(WORDClass)
  }

  prevWORD() {
    return this.prevWordLike(WORDClass)
  }

  endOfWORD() {
    return this.endOfWordLike(WORDClass)
  }

  /** Plain word aliases used by the search hook (meta+f / meta+b). */
  nextWord() {
    return this.nextVimWord()
  }

  prevWord() {
    return this.prevVimWord()
  }

  // -- find (f/F/t/T) -------------------------------------------------------

  /**
   * @param ch single character to find
   * @param type "f" | "F" | "t" | "T" (FindType)
   * @param count repeat count
   * @returns the new offset — `this.offset` when not found (vim: no move)
   */
  findCharacter(ch, type, count = 1) {
    const t = this.text
    const n = clamp(Math.trunc(count) || 1, 1, Number.MAX_SAFE_INTEGER)
    const forward = type === "f" || type === "t"
    const onTarget = type === "f" || type === "F"
    let i = this.offset
    for (let hit = 0; hit < n; hit++) {
      if (forward) {
        let j = i + 1
        while (j < t.length && t[j] !== ch) j++
        if (j >= t.length) return this.offset // not found: no move
        i = j
      } else {
        let j = i - 1
        while (j >= 0 && t[j] !== ch) j++
        if (j < 0) return this.offset
        i = j
      }
    }
    if (onTarget) return i
    const landed = forward ? i - 1 : i + 1
    // t/T landing must stay strictly on our side of the origin.
    const origin = this.offset
    if (forward && landed <= origin) return origin
    if (!forward && landed >= origin) return origin
    return landed
  }

  // -- editing (each returns a new cursor) ----------------------------------

  insert(str) {
    const chunk = typeof str === "string" ? str : ""
    if (chunk.length === 0) return this
    const t = this.text
    return new Cursor(t.slice(0, this.offset) + chunk + t.slice(this.offset), this.offset + chunk.length)
  }

  backspace() {
    if (this.offset === 0) return this
    const t = this.text
    return new Cursor(t.slice(0, this.offset - 1) + t.slice(this.offset), this.offset - 1)
  }

  del() {
    const t = this.text
    if (this.offset >= t.length) return this
    return new Cursor(t.slice(0, this.offset) + t.slice(this.offset + 1), this.offset)
  }

  // Kill-style deletes return `{ cursor, killed }` (self-referential,
  // non-enumerable) — the search hook destructures most of these as tuples
  // but reads `deleteWordAfter` as a plain cursor.
  deleteToLineStart() {
    const start = lineStartOf(this.text, this.offset)
    const killed = this.text.slice(start, this.offset)
    return killResult(new Cursor(this.text.slice(0, start) + this.text.slice(this.offset), start), killed)
  }

  deleteToLineEnd() {
    const end = lineEndOf(this.text, this.offset)
    const killed = this.text.slice(this.offset, end)
    return killResult(new Cursor(this.text.slice(0, this.offset) + this.text.slice(end), this.offset), killed)
  }

  deleteWordBefore() {
    const target = this.prevVimWord().offset
    if (target === this.offset) return killResult(this, "")
    const killed = this.text.slice(target, this.offset)
    return killResult(new Cursor(this.text.slice(0, target) + this.text.slice(this.offset), target), killed)
  }

  deleteWordAfter() {
    const target = this.nextVimWord().offset
    if (target === this.offset) return killResult(this, "")
    const killed = this.text.slice(this.offset, target)
    return killResult(new Cursor(this.text.slice(0, this.offset) + this.text.slice(target), this.offset), killed)
  }
}

/** Attach `{ cursor: self, killed }` without polluting enumeration/clones. */
const killResult = (cursor, killed) =>
  Object.defineProperties(cursor, {
    cursor: { value: cursor, enumerable: false, configurable: true },
    killed: { value: killed, enumerable: false, configurable: true },
  })

// ---------------------------------------------------------------------------
// kill ring + yank state
// ---------------------------------------------------------------------------

/** Newest first. */
let killRing = []
/** Consecutive-kill window: set by push, cleared by resetKillAccumulation. */
let accumulating = false
/** Active yank region (set by recordYank), rotated by yankPop. */
let yankState = null

const accumulation = { direction: "prepend" }

export function pushToKillRing(text, position = "prepend") {
  if (typeof text !== "string" || text.length === 0) return
  if (accumulating && killRing.length > 0 && accumulation.direction === position) {
    // Consecutive kills merge: backward kills (ctrl+u) PREPEND so a later
    // yank restores original order; forward kills (ctrl+k) APPEND.
    killRing[0] = position === "append" ? killRing[0] + text : text + killRing[0]
  } else {
    killRing.unshift(text)
  }
  accumulation.direction = position
  accumulating = true
}

export function getLastKill() {
  return killRing[0] ?? ""
}

export function resetKillAccumulation() {
  accumulating = false
}

export function recordYank(start, length) {
  yankState = { start, length, index: 0 }
}

export function updateYankLength(length) {
  if (yankState) yankState.length = length
}

/** Rotate to the next-older ring entry for the active yank region. */
export function yankPop() {
  if (!yankState || killRing.length === 0) return null
  yankState.index = (yankState.index + 1) % killRing.length
  return { text: killRing[yankState.index], start: yankState.start, length: yankState.length }
}

export function resetYankState() {
  yankState = null
}
