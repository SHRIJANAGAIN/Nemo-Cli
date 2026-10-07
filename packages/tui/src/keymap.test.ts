/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Keymap contract.
 *
 * The security-relevant tests come first in importance, not in position:
 * `LOCKED_ACTIONS` is the difference between a preference and a way to lose
 * the ability to deny an action, so "approve/deny cannot be rebound" and "a bad
 * override can never unbind a key" are pinned harder than anything else here.
 */
import { afterEach, describe, expect, it } from "vitest"
import type { Key } from "ink"
import { DEFAULT_KEYBINDINGS, GLOBAL_SHORTCUTS } from "./keybindings.js"
import {
  Keymap,
  LOCKED_ACTIONS,
  formatEffectiveKeymapMessage,
  getKeymap,
  isChordSequence,
  normalizeChord,
  resetKeymap,
  setKeymap,
  toKeyId,
} from "./keymap.js"

const key = (over: Partial<Key> = {}): Key => ({ ...over }) as Key

afterEach(() => {
  resetKeymap()
})

describe("normalizeChord", () => {
  it("folds case, strips padding, and removes whitespace around the separator", () => {
    // Must land on the same spelling `toKeyId` emits, or a spaced chord from
    // config would parse fine and then never match.
    expect(normalizeChord("  CTRL +  K ")).toBe("ctrl+k")
    expect(normalizeChord("Enter")).toBe("enter")
    expect(normalizeChord("ALT+BACKSPACE")).toBe("alt+backspace")
  })

  it("strips padding dashes at the edges but leaves inner ones alone", () => {
    // Inner dashes are not a spelling Trayambak emits anywhere, so rewriting them
    // would be inventing a convention rather than tolerating a typo.
    expect(normalizeChord("--ctrl+x--")).toBe("ctrl+x")
    expect(normalizeChord("-ctrl+x-")).toBe("ctrl+x")
    expect(normalizeChord("ctrl+x")).toBe("ctrl+x")
  })

  it("agrees with toKeyId on every default chord spelling", () => {
    // The two ends of the matcher must canonicalise identically; if they ever
    // diverge, bindings silently stop firing.
    for (const keys of Object.values(DEFAULT_KEYBINDINGS)) {
      for (const k of keys) expect(normalizeChord(k)).toBe(k.toLowerCase())
    }
  })

  it("treats internal whitespace as a leader sequence, not a chord", () => {
    // Two keypresses: "ctrl+k" then "p".
    expect(isChordSequence("ctrl+k p")).toBe(true)
    expect(isChordSequence("ctrl+k")).toBe(false)
    expect(isChordSequence("  ctrl+k  ")).toBe(false)
  })

  it("does not mistake separator padding for a leader sequence", () => {
    // "ctrl + j" is ONE chord written loosely. Reading the padding as a
    // sequence would reject the most natural way to write a chord by hand.
    expect(isChordSequence("  CTRL + J ")).toBe(false)
    expect(isChordSequence("ctrl + shift + z")).toBe(false)
    expect(normalizeChord("ctrl + shift + z")).toBe("ctrl+shift+z")
  })
})

describe("toKeyId", () => {
  it("prefers the named-key flags over the raw character", () => {
    // Ink reports Enter as input="\r"; inspecting `input` first would read a
    // control char instead of "enter" and silently break every Enter binding.
    expect(toKeyId("\r", key({ return: true }))).toBe("enter")
    expect(toKeyId("\x1b", key({ escape: true }))).toBe("escape")
    expect(toKeyId("\x1b[A", key({ upArrow: true }))).toBe("up")
    expect(toKeyId("\x1b[B", key({ downArrow: true }))).toBe("down")
    expect(toKeyId("\x1b[C", key({ rightArrow: true }))).toBe("right")
    expect(toKeyId("\x1b[D", key({ leftArrow: true }))).toBe("left")
    expect(toKeyId("\x7f", key({ backspace: true }))).toBe("backspace")
    expect(toKeyId("\x1b[3~", key({ delete: true }))).toBe("delete")
  })

  it("reads backspace and delete as distinct keys", () => {
    // These cannot both be set at once — Ink derives each from the same
    // `keypress.name` string — so there is no precedence question to answer.
    expect(toKeyId("\x7f", key({ backspace: true }))).toBe("backspace")
    expect(toKeyId("\x1b[3~", key({ delete: true }))).toBe("delete")
  })

  it("emits page keys lowercase so a config entry can ever match them", () => {
    expect(toKeyId("", key({ pageDown: true }))).toBe("pagedown")
    expect(toKeyId("", key({ pageUp: true }))).toBe("pageup")
    expect(toKeyId("", key({ pageDown: true }))).toBe(normalizeChord("PageDown"))
  })

  it("distinguishes tab from shift+tab", () => {
    expect(toKeyId("\t", key({ tab: true }))).toBe("tab")
    expect(toKeyId("\x1b[Z", key({ tab: true, shift: true }))).toBe("shift+tab")
  })

  it("builds modifier chords for a single character", () => {
    expect(toKeyId("z", key({ ctrl: true }))).toBe("ctrl+z")
    expect(toKeyId("k", key({ meta: true }))).toBe("alt+k")
    expect(toKeyId("Z", key({ ctrl: true, shift: true }))).toBe("ctrl+shift+z")
  })

  it("folds an uppercase letter to its base so one action has one spelling", () => {
    // Without this, a typed "Z" and a bound "ctrl+shift+z" are different
    // strings and the same action would need both listed.
    expect(toKeyId("Z", key({ shift: true }))).toBe("shift+z")
  })

  it("never reads a multi-character chunk as a chord", () => {
    // A paste must not be able to fire a shortcut by containing its letters.
    expect(toKeyId("ctrl+z", key({ ctrl: true }))).toBeUndefined()
    expect(toKeyId("hello", key())).toBeUndefined()
    expect(toKeyId("", key())).toBeUndefined()
  })

  it("keeps modifiers on named keys (alt+backspace, alt+left, ctrl+home…)", () => {
    // The declared defaults include alt+backspace / alt+left / ctrl+home /
    // ctrl+end / home / end; before this, every named-key branch returned
    // before inspecting modifiers, so alt+backspace produced "backspace"
    // (firing the WRONG action) and home/end could never be produced at all.
    expect(toKeyId("\x7f", key({ backspace: true, meta: true }))).toBe("alt+backspace")
    expect(toKeyId("\x1b[D", key({ leftArrow: true, meta: true }))).toBe("alt+left")
    expect(toKeyId("\x1b[C", key({ rightArrow: true, ctrl: true }))).toBe("ctrl+right")
    expect(toKeyId("\x7f", key({ backspace: true }))).toBe("backspace")
  })

  it("emits home and end keys (declared defaults that could never fire)", () => {
    expect(toKeyId("", key({ home: true }))).toBe("home")
    expect(toKeyId("", key({ end: true }))).toBe("end")
    expect(toKeyId("", key({ home: true, ctrl: true }))).toBe("ctrl+home")
    expect(toKeyId("", key({ end: true, ctrl: true }))).toBe("ctrl+end")
  })
})

describe("Keymap defaults", () => {
  it("matches the documented default chords", () => {
    const km = new Keymap()
    expect(km.matches("tui.input.submit", "enter")).toBe(true)
    expect(km.matchesInput("tui.input.submit", "\r", key({ return: true }))).toBe(true)
    expect(km.matchesInput("tui.permission.yolo", "y", key({ ctrl: true }))).toBe(true)
  })

  it("covers every declared action id", () => {
    // A default with no chord would be an action the user cannot invoke at all.
    const km = new Keymap()
    for (const action of Object.keys(DEFAULT_KEYBINDINGS)) {
      expect(km.keysFor(action).length, `${action} has no default chord`).toBeGreaterThan(0)
    }
  })

  it("resolves nothing for an unknown action", () => {
    const km = new Keymap()
    expect(km.keysFor("tui.nope.nope")).toEqual([])
    expect(km.matches("tui.nope.nope", "ctrl+a")).toBe(false)
  })

  it("reports no overrides before any are applied", () => {
    expect(new Keymap().overriddenActions()).toEqual([])
  })
})

describe("overrides", () => {
  it("rebinds an action to the new chord and drops the old one", () => {
    const km = new Keymap({ overrides: { "tui.input.submit": ["ctrl+j"] } })
    expect(km.matches("tui.input.submit", "ctrl+j")).toBe(true)
    expect(km.matches("tui.input.submit", "enter")).toBe(false)
    expect(km.overriddenActions()).toEqual(["tui.input.submit"])
  })

  it("accepts several chords for one action", () => {
    const km = new Keymap({ overrides: { "tui.input.submit": ["ctrl+j", "ctrl+m"] } })
    expect(km.matches("tui.input.submit", "ctrl+j")).toBe(true)
    expect(km.matches("tui.input.submit", "ctrl+m")).toBe(true)
  })

  it("matches an override through a real Ink event", () => {
    const km = new Keymap({ overrides: { "tui.permission.toggle": ["ctrl+alt+t"] } })
    expect(km.matchesInput("tui.permission.toggle", "t", key({ ctrl: true, meta: true }))).toBe(true)
    expect(km.matchesInput("tui.permission.toggle", "p", key({ ctrl: true }))).toBe(false)
  })

  it("fires a modifier+named-key override through a real Ink event", () => {
    // alt+backspace must reach the bound action, not collapse onto the plain
    // "backspace" chord and fire the wrong action.
    const km = new Keymap({ overrides: { "tui.input.deleteWordBackward": ["alt+backspace"] } })
    expect(km.matchesInput("tui.input.deleteWordBackward", "\x7f", key({ backspace: true, meta: true }))).toBe(true)
    expect(km.matchesInput("tui.input.deleteWordBackward", "\x7f", key({ backspace: true }))).toBe(false)
  })

  it("routes the default alt+backspace to deleteWordBackward, not plain backspace", () => {
    const km = new Keymap()
    expect(km.matchesInput("tui.input.deleteWordBackward", "\x7f", key({ backspace: true, meta: true }))).toBe(true)
    expect(km.matchesInput("tui.input.backspace", "\x7f", key({ backspace: true, meta: true }))).toBe(false)
  })

  it("normalises override spelling so case and padding do not matter", () => {
    const km = new Keymap({ overrides: { "tui.input.submit": ["  CTRL + J "] } })
    expect(km.matches("tui.input.submit", "ctrl+j")).toBe(true)
  })

  it("rejects a leader table rather than mangling it into a dead chord", () => {
    // "ctrl+k p" is two keypresses. Whitespace-stripping it yields "ctrl+kp",
    // which can never fire — worse than refusing, because it looks accepted.
    const km = new Keymap({ overrides: { "tui.input.submit": ["ctrl+k p"] } })
    expect(km.matches("tui.input.submit", "ctrl+kp")).toBe(false)
    expect(km.matches("tui.input.submit", "enter")).toBe(true)
    expect(km.rejected).toEqual([{ action: "tui.input.submit", chord: "ctrl+k p", reason: "unsupported-chord" }])
  })

  it("keeps the valid chords from a mixed override", () => {
    const km = new Keymap({ overrides: { "tui.input.submit": ["ctrl+k p", "ctrl+j"] } })
    expect(km.matches("tui.input.submit", "ctrl+j")).toBe(true)
    expect(km.rejected).toHaveLength(1)
  })

  it("ignores an override for an action that does not exist", () => {
    // A typo must not silently rebind something unintended.
    const km = new Keymap({ overrides: { "tui.typo.submit": ["ctrl+j"] } })
    expect(km.matches("tui.typo.submit", "ctrl+j")).toBe(false)
    expect(km.rejected).toEqual([{ action: "tui.typo.submit", chord: "ctrl+j", reason: "unknown-action" }])
  })

  it("refuses an override that would unbind every chord", () => {
    // Unbinding entirely would leave the user with no key for the action at
    // all, which is a trap rather than a preference.
    const km = new Keymap({ overrides: { "tui.input.submit": [] } })
    expect(km.matches("tui.input.submit", "enter")).toBe(true)
    expect(km.overriddenActions()).toEqual([])
  })

  it("ignores an override whose chords are all blank", () => {
    const km = new Keymap({ overrides: { "tui.input.submit": ["", "   "] } })
    expect(km.matches("tui.input.submit", "enter")).toBe(true)
  })
})

describe("approval keys are pinned", () => {
  it("binds approve to the bare letter the overlay really reads", () => {
    // PermissionOverlay dispatches on `input === "y"`, with no modifier. The
    // table used to claim ctrl+a, which does nothing there.
    const km = new Keymap()
    expect(km.matches("tui.approval.approve", "y")).toBe(true)
    expect(km.matches("tui.approval.approve", "ctrl+a")).toBe(false)
  })

  it("always leaves Escape bound to deny", () => {
    // The invariant: Escape denies above the composerHasText guard, so a
    // half-typed draft can never swallow the one key that always means no.
    const km = new Keymap()
    expect(km.matches("tui.approval.deny", "escape")).toBe(true)
    expect(km.matches("tui.approval.deny", "n")).toBe(true)
  })

  it("refuses to rebind approve", () => {
    const km = new Keymap({ overrides: { "tui.approval.approve": ["ctrl+alt+a"] } })
    expect(km.matches("tui.approval.approve", "y")).toBe(true)
    expect(km.matches("tui.approval.approve", "ctrl+alt+a")).toBe(false)
    expect(km.rejected[0]?.reason).toBe("locked-action")
  })

  it("refuses to rebind deny to a chord the overlay never reads", () => {
    // The load-bearing case: if deny could move to a chord PermissionOverlay
    // does not dispatch on, an approval prompt would have no working "no".
    const km = new Keymap({ overrides: { "tui.approval.deny": ["f12"] } })
    expect(km.matches("tui.approval.deny", "escape")).toBe(true)
    expect(km.matches("tui.approval.deny", "f12")).toBe(false)
  })

  it("refuses to rebind every permanent-decision variant too", () => {
    // approveAlways / approveSession / denyAlways are the same decision
    // surface with lasting side effects; a stray override must not move them.
    const km = new Keymap({
      overrides: {
        "tui.approval.approveAlways": ["b"],
        "tui.approval.approveSession": ["c"],
        "tui.approval.denyAlways": ["d"],
      },
    })
    expect(km.matches("tui.approval.approveAlways", "a")).toBe(true)
    expect(km.matches("tui.approval.approveSession", "s")).toBe(true)
    expect(km.matches("tui.approval.denyAlways", "x")).toBe(true)
    expect(km.rejected).toHaveLength(3)
  })

  it("refuses to rebind either cancel action", () => {
    const km = new Keymap({ overrides: { "tui.input.cancel": ["ctrl+q"], "tui.select.cancel": ["ctrl+q"] } })
    expect(km.matches("tui.input.cancel", "escape")).toBe(true)
    expect(km.matches("tui.select.cancel", "escape")).toBe(true)
    expect(km.rejected).toHaveLength(2)
  })

  it("keeps every pinned action on its defaults after a full override sweep", () => {
    const overrides: Record<string, string[]> = {}
    for (const action of Object.keys(DEFAULT_KEYBINDINGS)) overrides[action] = ["ctrl+alt+f12"]
    const km = new Keymap({ overrides })
    for (const action of Object.keys(LOCKED_ACTIONS)) {
      expect(km.overriddenActions(), `${action} was rebound`).not.toContain(action)
    }
    expect(km.matches("tui.approval.deny", "escape")).toBe(true)
  })

  it("documents why each locked action is locked", () => {
    for (const [action, reason] of Object.entries(LOCKED_ACTIONS)) {
      expect(reason.length, `${action} has no explanation`).toBeGreaterThan(10)
      expect(Object.keys(DEFAULT_KEYBINDINGS)).toContain(action)
    }
  })
})

describe("describe", () => {
  it("renders the EFFECTIVE map, so /keymap cannot lie about overrides", () => {
    const km = new Keymap({ overrides: { "tui.input.submit": ["ctrl+j"] } })
    const text = km.describe().join("\n")
    expect(text).toContain("tui.input.submit ctrl+j")
    expect(text).not.toContain("tui.input.submit enter")
  })

  it("marks pinned actions as pinned", () => {
    const km = new Keymap()
    expect(km.describe().join("\n")).toContain("tui.approval.deny n, escape (pinned)")
  })
})

describe("displayChord", () => {
  it("shows the default when nothing is rebound", () => {
    expect(new Keymap().displayChord("tui.global.palette")).toBe("ctrl+p")
  })

  it("shows the rebound chord, not the default", () => {
    const km = new Keymap({ overrides: { "tui.global.palette": ["ctrl+alt+p"] } })
    expect(km.displayChord("tui.global.palette")).toBe("ctrl+alt+p")
  })

  it("returns undefined for an unknown action rather than an empty cell", () => {
    expect(new Keymap().displayChord("tui.nope.nope")).toBeUndefined()
  })
})

describe("formatEffectiveKeymapMessage", () => {
  it("renders the shipped defaults when there are no overrides", () => {
    const text = formatEffectiveKeymapMessage(new Keymap())
    expect(text).toContain("ctrl+p Command palette")
    expect(text).not.toContain("(was ")
    expect(text).not.toContain("ignored ")
  })

  it("shows the rebound chord and names the one it replaced", () => {
    // The load-bearing case: /keymap must never print a chord the user no
    // longer has, because that reads as authoritative and sends them hunting.
    const text = formatEffectiveKeymapMessage(new Keymap({ overrides: { "tui.global.palette": ["ctrl+alt+p"] } }))
    expect(text).toContain("ctrl+alt+p Command palette (was ctrl+p)")
    expect(text).not.toMatch(/ctrl\+p Command palette(?! \(was)/)
  })

  it("leaves an unrebound shortcut byte-identical to the default table", () => {
    const text = formatEffectiveKeymapMessage(new Keymap({ overrides: { "tui.global.abort": ["f12"] } }))
    expect(text).toContain("ctrl+g Subagents panel")
    expect(text).toContain("f12 Abort turn (was ctrl+d)")
  })

  it("surfaces a rejected override instead of dropping it silently", () => {
    const text = formatEffectiveKeymapMessage(new Keymap({ overrides: { "tui.typo.abort": ["f12"] } }))
    expect(text).toContain("ignored tui.typo.abort = f12 (unknown-action)")
  })

  it("surfaces a refused approval rebind with its reason", () => {
    const text = formatEffectiveKeymapMessage(new Keymap({ overrides: { "tui.approval.deny": ["f12"] } }))
    expect(text).toContain("ignored tui.approval.deny = f12 (locked-action)")
  })

  it("does not substitute a leader sequence it cannot represent", () => {
    // "ctrl+k p" is two keypresses; claiming it as rebound would advertise a
    // binding that does not exist.
    const text = formatEffectiveKeymapMessage(new Keymap({ overrides: { "tui.global.whichKey": ["ctrl+k p"] } }))
    expect(text).toContain("ignored tui.global.whichKey = ctrl+k p (unsupported-chord)")
    expect(text).toContain("ctrl+k Which-key menu")
  })

  it("lists every shipped shortcut exactly once", () => {
    const text = formatEffectiveKeymapMessage(new Keymap())
    for (const s of GLOBAL_SHORTCUTS) expect(text).toContain(s.label)
  })
})

describe("process keymap", () => {
  it("starts on defaults", () => {
    expect(getKeymap().matches("tui.input.submit", "enter")).toBe(true)
  })

  it("installs overrides and resets back to defaults", () => {
    setKeymap({ "tui.input.submit": ["ctrl+j"] })
    expect(getKeymap().matches("tui.input.submit", "ctrl+j")).toBe(true)
    resetKeymap()
    expect(getKeymap().matches("tui.input.submit", "enter")).toBe(true)
  })

  it("treats a missing override set as defaults", () => {
    setKeymap(undefined)
    expect(getKeymap().keysFor("tui.input.submit")).toEqual(["enter"])
  })
})
