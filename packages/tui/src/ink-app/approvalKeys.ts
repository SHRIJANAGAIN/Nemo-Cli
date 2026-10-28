/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The approval key map, as a pure function.
 *
 * This was inline in PermissionOverlay's `useInput` and therefore untestable —
 * driving it needed a live Ink stdin, which is both brittle across Ink upgrades
 * and prone to false passes (a harness that delivers nothing makes every
 * "nothing happened" assertion green). The mapping itself is a straight-line
 * if-chain with no state beyond `composerHasText`, so it belongs here where it
 * can be tested directly and cheaply.
 *
 * Note what is NOT here: Escape. PermissionOverlay handles `key.escape` itself,
 * above this function and above the composer guard, because "Esc always denies"
 * is a structural guarantee rather than a table entry. A refactor that moved
 * Escape into a data table would be able to unbind it, and an approval prompt
 * with no reachable "no" is the one failure this file exists to prevent.
 */

import { isEnter } from "./keys.js"

/** The subset of Ink's Key shape this mapping reads. */
export interface ApprovalKeyLike {
  readonly escape?: boolean
  readonly upArrow?: boolean
  readonly downArrow?: boolean
}

/** What a single approval keypress decided. */
export type ApprovalDecision = "approve" | "deny" | "approveAlways" | "approveSession" | "denyAlways"

const DECISION_KEYS: Readonly<Record<string, ApprovalDecision>> = {
  y: "approve",
  Y: "approve",
  n: "deny",
  N: "deny",
  a: "approveAlways",
  A: "approveAlways",
  s: "approveSession",
  S: "approveSession",
  x: "denyAlways",
  X: "denyAlways",
}

/**
 * The decision a keypress makes on the pending request, or null for "not a
 * decision key" (navigation, modifier chords, an unmapped key, or any key at
 * all while the composer holds a draft).
 *
 * While `composerHasText` is true the overlay must stand down: Ink broadcasts
 * every keypress to every `useInput` handler, so "y" would otherwise approve the
 * request *and* type a y into the composer in the same press. Escape is exempt —
 * see the note above.
 */
export function approvalDecisionFor(
  input: string,
  key: ApprovalKeyLike,
  composerHasText: boolean,
): ApprovalDecision | null {
  if (composerHasText) return null
  if (isEnter(input, key as Parameters<typeof isEnter>[1])) return "approve"
  return DECISION_KEYS[input] ?? null
}

/** Navigation movement for an approval keypress, clamped to the list bounds. */
export function approvalNavigationFor(input: string, key: ApprovalKeyLike): -1 | 0 | 1 {
  if (key.upArrow) return -1
  if (key.downArrow) return 1
  // A bare ESC-prefixed sequence that is not a recognised arrow can arrive as
  // raw text; only the flags count as navigation.
  void input
  return 0
}
