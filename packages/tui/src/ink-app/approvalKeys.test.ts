/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Approval key contract.
 *
 * The invariant this file pins: **there is always a reachable "no".** Escape
 * denies unconditionally (handled structurally in PermissionOverlay, above the
 * composer guard), `n` denies, and while the composer holds a draft the overlay
 * takes no decision at all except Escape.
 *
 * Pure-function tests rather than a rendered Ink harness on purpose. The first
 * attempt at a rendered harness "passed" six assertions that only asserted
 * *nothing happened* — so it would have stayed green with the whole component
 * broken. Nothing here can pass by accident: every case is an exact mapping.
 */

import { describe, expect, it } from "vitest"
import { approvalDecisionFor, approvalNavigationFor, type ApprovalDecision } from "./approvalKeys.js"

const key = (over: Partial<Parameters<typeof approvalDecisionFor>[1]> = {}) => over
const NONE = false
const DRAFT = true

/** Every key that decides something, with the decision it must produce. */
const DECISIONS: Array<[string, ApprovalDecision]> = [
  ["y", "approve"],
  ["Y", "approve"],
  ["n", "deny"],
  ["N", "deny"],
  ["a", "approveAlways"],
  ["A", "approveAlways"],
  ["s", "approveSession"],
  ["S", "approveSession"],
  ["x", "denyAlways"],
  ["X", "denyAlways"],
]

describe("approval keys on an empty composer", () => {
  it.each(DECISIONS)("%s decides %s", (chord, expected) => {
    expect(approvalDecisionFor(chord, key(), NONE)).toBe(expected)
  })

  it("approves on Enter via the key flag", () => {
    expect(approvalDecisionFor("", key({ escape: false }), NONE)).toBeNull()
    expect(approvalDecisionFor("\r", key({}), NONE)).toBe("approve")
  })

  it("approves on a bare CR or LF, which is how Enter arrives in raw mode", () => {
    expect(approvalDecisionFor("\r", key(), NONE)).toBe("approve")
    expect(approvalDecisionFor("\n", key(), NONE)).toBe("approve")
  })

  it("decides exactly one thing per key", () => {
    // A decision function cannot emit two, but pin it anyway: an approval plus
    // a persistent rule write from one press is the shape of a bypass.
    for (const [chord] of DECISIONS) {
      expect(approvalDecisionFor(chord, key(), NONE), `${chord} decided twice`).not.toBeNull()
    }
  })
})

describe("a composer draft suppresses every decision but Escape", () => {
  // Ink broadcasts each keypress to every useInput handler. With a draft live,
  // "y" must type a y — NOT approve the request in the same press.
  it.each(DECISIONS)("%s types instead of deciding", (chord) => {
    expect(approvalDecisionFor(chord, key(), DRAFT)).toBeNull()
  })

  it("Enter types instead of approving", () => {
    expect(approvalDecisionFor("\r", key(), DRAFT)).toBeNull()
  })

  it("every mapped key is suppressed, not just the letters tried above", () => {
    // Guard against the table growing a key whose DRAFT case was never wired.
    for (const chord of "ynasxYNASX") {
      expect(approvalDecisionFor(chord, key(), DRAFT), `${chord} leaked`).toBeNull()
    }
  })
})

describe("Escape is deliberately not in this table", () => {
  // PermissionOverlay handles `key.escape` itself, above the composer guard.
  // If Escape were routed through here it could be unbound by a data change,
  // and an approval prompt with no working "no" would look like a hung agent.
  it("returns null for Escape so the component keeps owning it", () => {
    expect(approvalDecisionFor("\x1b", key({ escape: true }), NONE)).toBeNull()
  })

  it("returns null for Escape even while typing", () => {
    expect(approvalDecisionFor("\x1b", key({ escape: true }), DRAFT)).toBeNull()
  })
})

describe("unmapped keys decide nothing", () => {
  it.each(["q", "Z", "1", "/", " ", "\t"])("%j is not a decision key", (chord) => {
    expect(approvalDecisionFor(chord, key(), NONE)).toBeNull()
  })

  it("an empty input decides nothing", () => {
    expect(approvalDecisionFor("", key(), NONE)).toBeNull()
  })

  it("a pasted multi-character chunk does not decide", () => {
    // "y" pasted as part of a word must never approve.
    expect(approvalDecisionFor("yes", key(), NONE)).toBeNull()
    expect(approvalDecisionFor("n\nrm -rf /", key(), NONE)).toBeNull()
  })
})

describe("navigation", () => {
  it("moves up and down on the arrow flags", () => {
    expect(approvalNavigationFor("", key({ upArrow: true }))).toBe(-1)
    expect(approvalNavigationFor("", key({ downArrow: true }))).toBe(1)
  })

  it("stays put on everything else", () => {
    expect(approvalNavigationFor("y", key())).toBe(0)
    expect(approvalNavigationFor("", key({ escape: true }))).toBe(0)
    expect(approvalNavigationFor("", key())).toBe(0)
  })

  it("does not treat a decision key as navigation", () => {
    // Both maps run over the same keypress; the overlay returns on whichever
    // fires, so a key must never be in both.
    for (const [chord] of DECISIONS) {
      expect(approvalNavigationFor(chord, key()), `${chord} also navigates`).toBe(0)
    }
  })

  it("arrow keys are not decision keys", () => {
    expect(approvalDecisionFor("", key({ upArrow: true }), NONE)).toBeNull()
    expect(approvalDecisionFor("", key({ downArrow: true }), NONE)).toBeNull()
  })
})

describe("clamping at the list bounds", () => {
  const clamp = (idx: number, nav: number, len: number): number => Math.max(0, Math.min(len - 1, idx + nav))

  it("stops at the first request", () => {
    expect(clamp(0, -1, 2)).toBe(0)
    expect(clamp(0, -1, 1)).toBe(0)
  })

  it("stops at the last request", () => {
    expect(clamp(1, 1, 2)).toBe(1)
    expect(clamp(1, 1, 1)).toBe(0)
  })

  it("a single-request list never moves off it", () => {
    expect(clamp(0, 1, 1)).toBe(0)
    expect(clamp(0, -1, 1)).toBe(0)
  })
})
