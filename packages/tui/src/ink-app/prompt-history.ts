/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Prompt history — the ring behind the composer's up/down arrows.
 *
 * Why this exists as its own module: the keymap has shipped
 * `tui.input.historyPrevious` / `historyNext` on ↑/↓ since the table was
 * written, and nothing read them. A binding nobody handles is worse than no
 * binding, because `/keymap` prints a key that does nothing when pressed.
 *
 * The semantics are readline's, not "an array you can page through", because
 * the difference is the thing users get wrong without noticing:
 *  - your half-typed draft is remembered the moment you press ↑, and comes
 *    back when you press ↓ past the newest entry — recall must never cost you
 *    text you had not sent yet;
 *  - what you edit after recalling belongs to YOU: the stored entry stays as
 *    sent, and the edited copy is what sits at the cursor;
 *  - sending the same prompt twice in a row stores it once, so ↑↑ does not
 *    waste a press on a duplicate.
 *
 * This is in-session only, and that is deliberate: the transcript already
 * persists every prompt to disk, so a second history file would duplicate the
 * data, not the feature — and a recall that crosses sessions needs a search
 * UI, not an arrow key.
 */

/** Entries kept, oldest first. Beyond this the oldest prompt is dropped. */
export const PROMPT_HISTORY_LIMIT = 50

export interface PromptHistory {
  /** Prompts already sent, oldest first. */
  entries: readonly string[]
  /** Which entry the composer shows; `entries.length` means the live draft. */
  cursor: number
  /** The draft that was in the composer when recall began. */
  draft: string
}

export function emptyPromptHistory(): PromptHistory {
  return { entries: [], cursor: 0, draft: "" }
}

/** What the composer should hold for this state. */
export function recalledText(h: PromptHistory): string {
  return h.cursor < h.entries.length ? (h.entries[h.cursor] ?? "") : h.draft
}

/** A prompt was sent: file it, drop any recall, and park the cursor at the
 *  bottom so the next ↑ starts from the newest thing. */
export function pushPrompt(h: PromptHistory, text: string): PromptHistory {
  const trimmed = text.trim()
  const bottom = { entries: h.entries, cursor: h.entries.length, draft: "" }
  if (!trimmed) return bottom
  if (h.entries[h.entries.length - 1] === trimmed) return bottom
  const entries = [...h.entries, trimmed]
  const kept = entries.length > PROMPT_HISTORY_LIMIT ? entries.slice(entries.length - PROMPT_HISTORY_LIMIT) : entries
  return { entries: kept, cursor: kept.length, draft: "" }
}

/** ↑ — one prompt older. `buffer` is the live draft, stashed on the first
 *  press so ↓ can give it back. At the oldest entry it does nothing. */
export function recallOlder(h: PromptHistory, buffer: string): PromptHistory {
  if (h.entries.length === 0 || h.cursor === 0) return h
  const draft = h.cursor === h.entries.length ? buffer : h.draft
  return { entries: h.entries, cursor: h.cursor - 1, draft }
}

/** ↓ — one prompt newer; past the newest, the stashed draft returns. */
export function recallNewer(h: PromptHistory): PromptHistory {
  if (h.cursor >= h.entries.length) return h
  return { entries: h.entries, cursor: h.cursor + 1, draft: h.draft }
}

/** Out of recall without losing the entries (Esc) — the stashed draft comes
 *  back with you. A submit that cleared files the prompt instead. */
export function leaveRecall(h: PromptHistory): PromptHistory {
  return { entries: h.entries, cursor: h.entries.length, draft: h.draft }
}

/** True while the composer is showing a stored prompt rather than a draft —
 *  the state where a hint about "esc to leave history" is worth printing. */
export function isInRecall(h: PromptHistory): boolean {
  return h.cursor < h.entries.length
}
