/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { type FrecencyEntry, rankByFrecency } from "../../core/src/frecency.js"

/**
 * `@`-file picker logic.
 *
 * Deliberately free of Ink: the parts that are easy to get wrong — finding the
 * `@` token around a moving caret, splicing a completion in without eating the
 * character after it, and keeping a selection index inside a shrinking list —
 * are pure string and index arithmetic. They are also exactly the parts that
 * only misbehave interactively, so isolating them here is what makes them
 * testable at all.
 */

/** The `@`-token currently being typed under the caret. */
export interface MentionToken {
  /** Index of the `@` itself. */
  readonly start: number
  /** Index just past the last typed character of the query. */
  readonly end: number
  /** Query text after the `@`. */
  readonly query: string
}

/** How a path has to be written to survive a round trip through a shell. */
export function quotePath(candidate: string): string {
  if (!/[\s"'\\$`;&|<>()*?[\]#~=%]/.test(candidate)) return candidate
  const escaped = candidate.replace(/([\\"$`])/g, "\\$1")
  return `"${escaped}"`
}

/**
 * Characters that end a mention.
 *
 * A space is the obvious terminator, but so is anything a shell would treat as
 * an operator — typing `@a.ts&&rm` must not fold `&&rm` into the query and offer
 * a "path" containing it.
 */
const TOKEN_BREAK = new Set([" ", "\t", "\n", "\r", '"', "'", "`", ";", "&", "|", "<", ">", "(", ")", "$"])

/**
 * Find the `@`-token under `caret`, if there is one.
 *
 * Scans backwards from the caret and stops at the first token break. Two
 * conditions are load-bearing:
 *
 *  - The `@` must be ADJACENT to the query. `@ foo` is a word, not a mention, so
 *    a space between them disqualifies it (the scan stops before reaching `@`).
 *  - The `@` must START a token. An email address (`a@b.ts`) must not open a
 *    picker, so the preceding character may not be a path-ish character.
 */
export function detectMention(draft: string, caret: number): MentionToken | null {
  const at = Math.max(0, Math.min(caret, draft.length))
  let i = at
  // Walk back to whichever comes first: the `@`, or a token break. Returning null
  // at the break is what makes `look at @src/a` work — the space in `look at`
  // is the break that STOPS the scan, not a reason to reject a mention that has
  // not been found yet.
  while (i > 0) {
    const ch = draft[i - 1] ?? ""
    if (ch === "@") {
      i--
      break
    }
    if (TOKEN_BREAK.has(ch)) return null
    i--
  }
  if (draft[i] !== "@") return null
  // The caret must be strictly AFTER the `@`. With the caret sitting on it (or
  // to its left) there is no token under the cursor, and returning `{i, i, ""}`
  // would open the picker anchored to a position the user is not editing.
  if (at <= i) return null
  const before = i > 0 ? (draft[i - 1] ?? "") : ""
  // `foo@bar` is an address; `@bar` at the start of a draft is a mention.
  if (before !== "" && !TOKEN_BREAK.has(before)) return null
  return { start: i, end: at, query: draft.slice(i + 1, at) }
}

/** A prompt buffer after a completion. */
export interface DraftEdit {
  readonly draft: string
  readonly caret: number
}

/**
 * Replace the `@`-token with a completed path.
 *
 * A trailing space is added only when something follows, so completing at the
 * end of the draft does not leave a dangling space for the user to delete. When
 * text follows, the space is inserted so the next word stays a separate word.
 */
export function applyMention(draft: string, token: MentionToken, completion: string): DraftEdit {
  const quoted = quotePath(completion)
  const rest = draft.slice(token.end)
  const needsSpace = rest.length > 0 && !TOKEN_BREAK.has(rest[0] ?? "")
  const inserted = `${quoted}${needsSpace ? " " : ""}`
  return {
    draft: draft.slice(0, token.start) + inserted + rest,
    caret: token.start + inserted.length,
  }
}

/** One row of the picker. */
export interface PickerCandidate {
  readonly path: string
  /** 0 for a file never opened before. */
  readonly opens: number
  readonly lastOpened: number
}

export interface CandidateOptions {
  readonly query: string
  /** Known-working-set entries from the frecency store. */
  readonly frecency?: readonly FrecencyEntry[]
  /** Freshly scanned paths, used to fill in files never opened. */
  readonly scanned?: readonly string[]
  readonly limit?: number
  readonly now?: number
}

/**
 * Rank picker rows.
 *
 * Frecency ranks first and scanned paths fill the tail, but a scan hit that is
 * ALSO in the store must not appear twice — two rows for one file reads as a
 * bug and makes the list jump when the duplicate is picked.
 */
export function rankCandidates(options: CandidateOptions): PickerCandidate[] {
  const needle = options.query.trim().toLowerCase()
  const match = (p: string): boolean => needle === "" || p.toLowerCase().includes(needle)

  const seen = new Set<string>()
  const rows: PickerCandidate[] = []
  for (const entry of rankByFrecency(options.frecency ?? [], { now: options.now })) {
    if (!match(entry.path) || seen.has(entry.path)) continue
    seen.add(entry.path)
    rows.push({ path: entry.path, opens: entry.opens, lastOpened: entry.lastOpened })
  }
  // Never-opened files rank by query specificity, so typing more of the name
  // narrows the tail the same way it narrows the head.
  const tail = [...(options.scanned ?? [])]
    .filter((p) => match(p) && !seen.has(p))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
  for (const p of tail) rows.push({ path: p, opens: 0, lastOpened: 0 })

  return options.limit === undefined ? rows : rows.slice(0, Math.max(0, options.limit))
}

/** Picker cursor. `index` is meaningless while `open` is false. */
export interface PickerState {
  readonly query: string
  readonly index: number
  readonly open: boolean
}

export const CLOSED_PICKER: PickerState = { query: "", index: 0, open: false }

/** Open on a query, selecting the best row. */
export function openPicker(query: string): PickerState {
  return { query, index: 0, open: true }
}

/** Dismiss, resetting the cursor so re-opening does not restore a stale row. */
export function closePicker(state: PickerState): PickerState {
  return { ...CLOSED_PICKER, query: state.query }
}

/**
 * Move the selection, wrapping at both ends.
 *
 * Wrapping rather than clamping is what makes the list feel right: with the
 * arrow keys held down you expect to cycle, not to stick at the last row.
 */
export function moveSelection(state: PickerState, delta: number, count: number): PickerState {
  if (!state.open || count <= 0) return state
  const step = Math.trunc(delta)
  if (step === 0) return state
  // A large delta must not be able to skip past the ends even with `count === 1`.
  const wrapped = (((state.index + step) % count) + count) % count
  return { ...state, index: wrapped }
}

/**
 * Re-clamp after the candidate list changed.
 *
 * Typing narrows the list, so a selection at index 8 can be left pointing past
 * the end — the next keypress would then select a file the user never saw. Called
 * on every keystroke while the picker is open.
 */
export function clampSelection(state: PickerState, count: number): PickerState {
  if (!state.open || count <= 0) return { ...state, index: 0 }
  return { ...state, index: Math.max(0, Math.min(state.index, count - 1)) }
}
