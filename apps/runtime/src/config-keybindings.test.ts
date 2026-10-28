/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * `keybindings` config sanitisation.
 *
 * The config file is hand-editable JSON, so this is the untrusted-input
 * boundary. Everything here is about refusing a malformed value cleanly rather
 * than about deciding which bindings are legal — that policy lives in `Keymap`,
 * which reports rejections so `/keymap` can explain them.
 */
import { describe, expect, it } from "vitest"
import { sanitizeKeybindingsForTest } from "./config.js"

describe("sanitizeKeybindings", () => {
  it("returns undefined for a missing value", () => {
    expect(sanitizeKeybindingsForTest(undefined)).toBeUndefined()
    expect(sanitizeKeybindingsForTest(null)).toBeUndefined()
  })

  it("keeps a well-formed map untouched", () => {
    expect(sanitizeKeybindingsForTest({ "tui.global.palette": ["ctrl+alt+p"] })).toEqual({
      "tui.global.palette": ["ctrl+alt+p"],
    })
  })

  it("keeps several chords for one action", () => {
    expect(sanitizeKeybindingsForTest({ "tui.input.submit": ["ctrl+j", "ctrl+m"] })).toEqual({
      "tui.input.submit": ["ctrl+j", "ctrl+m"],
    })
  })

  it("drops non-objects rather than throwing", () => {
    // A hand-edited file with `"keybindings": "ctrl+p"` must not crash startup.
    for (const bad of ["ctrl+p", 42, true, ["ctrl+p"]]) {
      expect(sanitizeKeybindingsForTest(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })

  it("drops action ids that are not dotted lowercase tokens", () => {
    expect(
      sanitizeKeybindingsForTest({
        "tui.global.palette": ["ctrl+alt+p"],
        "": ["x"],
        UPPER: ["x"],
        single: ["x"],
        "trailing.": ["x"],
        ".leading": ["x"],
        "has space": ["x"],
        "double..dot": ["x"],
      }),
    ).toEqual({ "tui.global.palette": ["ctrl+alt+p"] })
  })

  it("drops a non-array value for an action", () => {
    expect(sanitizeKeybindingsForTest({ "tui.global.palette": "ctrl+alt+p" })).toBeUndefined()
    expect(sanitizeKeybindingsForTest({ "tui.global.palette": { 0: "ctrl+p" } })).toBeUndefined()
  })

  it("keeps only the string entries in a mixed array", () => {
    expect(sanitizeKeybindingsForTest({ "tui.global.palette": ["ctrl+p", 7, null, "ctrl+j"] })).toEqual({
      "tui.global.palette": ["ctrl+p", "ctrl+j"],
    })
  })

  it("drops an action whose chords are all the wrong type", () => {
    // Otherwise Keymap would see an empty array and, per its own rule, keep the
    // default while the config file appears to have bound it.
    expect(sanitizeKeybindingsForTest({ "tui.global.palette": [1, 2, null] })).toBeUndefined()
  })

  it("returns undefined when nothing survives", () => {
    expect(sanitizeKeybindingsForTest({ bad: ["x"], "also bad": ["y"] })).toBeUndefined()
    expect(sanitizeKeybindingsForTest({})).toBeUndefined()
  })

  it("passes locked and unknown actions through for Keymap to judge", () => {
    // Sanitising must NOT silently drop these: the user needs to be told their
    // override was refused, which only Keymap knows how to explain.
    expect(sanitizeKeybindingsForTest({ "tui.approval.deny": ["f12"], "tui.typo.nope": ["f12"] })).toEqual({
      "tui.approval.deny": ["f12"],
      "tui.typo.nope": ["f12"],
    })
  })
})
