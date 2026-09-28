/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { Key, matchesKey, parseKey } from "./keys.js"
import type { KeyId } from "./keys.js"

describe("parseKey", () => {
  it("decodes control characters and named keys", () => {
    expect(parseKey("\x1b")).toBe("escape")
    expect(parseKey("\t")).toBe("tab")
    expect(parseKey("\r")).toBe("enter")
    expect(parseKey("\n")).toBe("enter")
    expect(parseKey("\x00")).toBe("ctrl+space")
    expect(parseKey(" ")).toBe("space")
    expect(parseKey("\x7f")).toBe("backspace")
    expect(parseKey("\x08")).toBe("backspace")
    expect(parseKey("\x1b[Z")).toBe("shift+tab")
    expect(parseKey("\x1b\x7f")).toBe("alt+backspace")
    expect(parseKey("\x1b\b")).toBe("alt+backspace")
  })

  it("decodes arrows, navigation keys, and their SS3 forms", () => {
    expect(parseKey("\x1b[A")).toBe("up")
    expect(parseKey("\x1b[B")).toBe("down")
    expect(parseKey("\x1b[C")).toBe("right")
    expect(parseKey("\x1b[D")).toBe("left")
    expect(parseKey("\x1b[H")).toBe("home")
    expect(parseKey("\x1bOH")).toBe("home")
    expect(parseKey("\x1b[F")).toBe("end")
    expect(parseKey("\x1bOF")).toBe("end")
    expect(parseKey("\x1b[3~")).toBe("delete")
    expect(parseKey("\x1b[5~")).toBe("pageUp")
    expect(parseKey("\x1b[6~")).toBe("pageDown")
  })

  it("decodes legacy function-key and modifier sequences", () => {
    expect(parseKey("\x1bOP")).toBe("f1")
    expect(parseKey("\x1b[11~")).toBe("f1")
    expect(parseKey("\x1b[[A")).toBe("f1")
    expect(parseKey("\x1b[[E")).toBe("f5")
    expect(parseKey("\x1b[24~")).toBe("f12")
    expect(parseKey("\x1b[a")).toBe("shift+up")
    expect(parseKey("\x1bOa")).toBe("ctrl+up")
  })

  it("maps single control bytes to ctrl+letter", () => {
    expect(parseKey("\x01")).toBe("ctrl+a")
    expect(parseKey("\x1a")).toBe("ctrl+z")
  })

  it("returns printable characters as-is", () => {
    expect(parseKey("a")).toBe("a")
    expect(parseKey("Z")).toBe("Z")
    expect(parseKey("!")).toBe("!")
    expect(parseKey("5")).toBe("5")
  })

  it("returns undefined for unknown or unassigned input", () => {
    expect(parseKey("")).toBeUndefined()
    expect(parseKey("\x1b[999~")).toBeUndefined()
    expect(parseKey("\x1f")).toBeUndefined()
  })
})

describe("matchesKey", () => {
  it("matches escape, enter, tab, and space with their modifiers", () => {
    expect(matchesKey("\x1b", "escape")).toBe(true)
    expect(matchesKey("\x1b", "esc")).toBe(true)
    expect(matchesKey("x", "escape")).toBe(false)
    expect(matchesKey("\x1b", "ctrl+escape")).toBe(false)

    expect(matchesKey("\r", "enter")).toBe(true)
    expect(matchesKey("\n", "enter")).toBe(true)
    expect(matchesKey("\r", "return")).toBe(true)
    expect(matchesKey("\r", "ctrl+enter")).toBe(false)

    expect(matchesKey("\t", "tab")).toBe(true)
    expect(matchesKey("\x1b[Z", "shift+tab")).toBe(true)
    expect(matchesKey("\t", "shift+tab")).toBe(false)
    expect(matchesKey("\t", "alt+tab")).toBe(false)

    expect(matchesKey(" ", "space")).toBe(true)
    expect(matchesKey("\x00", "ctrl+space")).toBe(true)
    expect(matchesKey("\x1b ", "alt+space")).toBe(true)
    expect(matchesKey(" ", "shift+space")).toBe(false)
  })

  it("matches backspace and navigation keys with modifiers", () => {
    expect(matchesKey("\x7f", "backspace")).toBe(true)
    expect(matchesKey("\x08", "backspace")).toBe(true)
    expect(matchesKey("\x1b\x7f", "alt+backspace")).toBe(true)
    expect(matchesKey("\x08", "ctrl+backspace")).toBe(true)
    expect(matchesKey("\x7f", "shift+backspace")).toBe(false)

    expect(matchesKey("\x1b[3~", "delete")).toBe(true)
    expect(matchesKey("\x1b[2~", "insert")).toBe(true)
    expect(matchesKey("\x1b[3~", "ctrl+delete")).toBe(false)
    expect(matchesKey("\x1b[H", "home")).toBe(true)
    expect(matchesKey("\x1b[7~", "home")).toBe(true)
    expect(matchesKey("\x1b[F", "end")).toBe(true)
    expect(matchesKey("\x1b[8~", "end")).toBe(true)
    expect(matchesKey("\x1b[5~", "pageUp")).toBe(true)
    expect(matchesKey("\x1b[[5~", "pageUp")).toBe(true)
    expect(matchesKey("\x1b[6~", "pageDown")).toBe(true)
    expect(matchesKey("\x1b[[6~", "pageDown")).toBe(true)
  })

  it("matches arrows with alt and ctrl variants", () => {
    expect(matchesKey("\x1b[A", "up")).toBe(true)
    expect(matchesKey("\x1bOA", "up")).toBe(true)
    expect(matchesKey("\x1bp", "alt+up")).toBe(true)
    expect(matchesKey("\x1b[a", "alt+up")).toBe(true)
    expect(matchesKey("\x1bOa", "ctrl+up")).toBe(true)
    expect(matchesKey("\x1b[A", "shift+up")).toBe(false)

    expect(matchesKey("\x1b[B", "down")).toBe(true)
    expect(matchesKey("\x1bn", "alt+down")).toBe(true)
    expect(matchesKey("\x1bOb", "ctrl+down")).toBe(true)

    expect(matchesKey("\x1b[D", "left")).toBe(true)
    expect(matchesKey("\x1bb", "alt+left")).toBe(true)
    expect(matchesKey("\x1bOd", "ctrl+left")).toBe(true)

    expect(matchesKey("\x1b[C", "right")).toBe(true)
    expect(matchesKey("\x1bf", "alt+right")).toBe(true)
    expect(matchesKey("\x1bOc", "ctrl+right")).toBe(true)
  })

  it("matches every function key and rejects modified ones", () => {
    expect(matchesKey("\x1bOP", "f1")).toBe(true)
    expect(matchesKey("\x1b[11~", "f1")).toBe(true)
    expect(matchesKey("\x1b[[A", "f1")).toBe(true)
    expect(matchesKey("\x1bOQ", "f2")).toBe(true)
    expect(matchesKey("\x1b[15~", "f5")).toBe(true)
    expect(matchesKey("\x1b[[E", "f5")).toBe(true)
    expect(matchesKey("\x1b[17~", "f6")).toBe(true)
    expect(matchesKey("\x1b[18~", "f7")).toBe(true)
    expect(matchesKey("\x1b[19~", "f8")).toBe(true)
    expect(matchesKey("\x1b[20~", "f9")).toBe(true)
    expect(matchesKey("\x1b[21~", "f10")).toBe(true)
    expect(matchesKey("\x1b[23~", "f11")).toBe(true)
    expect(matchesKey("\x1b[24~", "f12")).toBe(true)
    expect(matchesKey("\x1bOP", "ctrl+f1")).toBe(false)
  })

  it("matches plain letters, digits, and symbols", () => {
    expect(matchesKey("a", "a")).toBe(true)
    expect(matchesKey("5", "5")).toBe(true)
    expect(matchesKey(",", ",")).toBe(true)
    expect(matchesKey("b", "c")).toBe(false)
    expect(matchesKey("€", "€" as KeyId)).toBe(false)
  })

  it("matches shift+letter against the uppercase byte", () => {
    expect(matchesKey("A", "shift+a")).toBe(true)
    expect(matchesKey("a", "shift+a")).toBe(false)
    expect(matchesKey("!", "shift+1")).toBe(false)
  })

  it("matches alt+letter, alt+digit, and alt+symbol escape forms", () => {
    expect(matchesKey("\x1ba", "alt+a")).toBe(true)
    expect(matchesKey("\x1b5", "alt+5")).toBe(true)
    expect(matchesKey("\x1b,", "alt+,")).toBe(true)
    expect(matchesKey("a", "alt+a")).toBe(false)
  })

  it("matches ctrl combinations via control bytes", () => {
    expect(matchesKey("\x01", "ctrl+a")).toBe(true)
    expect(matchesKey("\x1a", "ctrl+z")).toBe(true)
    expect(matchesKey("\x1f", "ctrl+-")).toBe(true)
    expect(matchesKey("a", "ctrl+a")).toBe(false)
    expect(matchesKey("5", "ctrl+5")).toBe(false) // no control byte for digits
    expect(matchesKey("\x1b\x01", "ctrl+alt+a")).toBe(true)
    expect(matchesKey("\x01", "ctrl+shift+a")).toBe(true) // shift is ignored for ctrl bytes
    expect(matchesKey("a", "super+a")).toBe(false)
  })

  it("rejects malformed or unsupported key ids", () => {
    expect(matchesKey("a", "" as KeyId)).toBe(false)
    expect(matchesKey("x", "f20" as KeyId)).toBe(false)
  })
})

describe("Key", () => {
  it("builds modified key ids", () => {
    expect(Key.ctrl("a")).toBe("ctrl+a")
    expect(Key.shift("a")).toBe("shift+a")
    expect(Key.alt("a")).toBe("alt+a")
    expect(Key.super("a")).toBe("super+a")
    expect(Key.ctrlShift("s")).toBe("ctrl+shift+s")
    expect(Key.ctrlAlt("t")).toBe("ctrl+alt+t")
  })

  it("exposes stable key constants", () => {
    expect(Key.escape).toBe("escape")
    expect(Key.pageUp).toBe("pageUp")
    expect(Key.f12).toBe("f12")
    expect(Key.backtick).toBe("`")
    expect(Key.hyphen).toBe("-")
  })
})
