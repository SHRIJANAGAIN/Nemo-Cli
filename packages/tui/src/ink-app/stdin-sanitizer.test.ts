/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { PASTE_END, PASTE_START, StdinSanitizer, rewriteEnters } from "./stdin-sanitizer.js"

const KPENTER = "\x1b[57414u"
const SS3_ENTER = "\x1bOM"

const newSanitizer = (): StdinSanitizer => {
  const san = new StdinSanitizer()
  return san
}

describe("rewriteEnters", () => {
  it("maps kitty keypad-Enter to a plain CR", () => {
    expect(rewriteEnters(`hey${KPENTER}`)).toBe("hey\r")
  })

  it("maps DEC application-keypad Enter to a plain CR", () => {
    expect(rewriteEnters(`hey${SS3_ENTER}`)).toBe("hey\r")
  })

  it("leaves ordinary typing, LF/CRLF and kitty CSI-u return untouched", () => {
    expect(rewriteEnters("hey\r\n\x1b[13u")).toBe("hey\r\n\x1b[13u")
  })

  it("rewrites every occurrence (split/join, no regex state)", () => {
    expect(rewriteEnters(`${KPENTER}${SS3_ENTER}${KPENTER}`)).toBe("\r\r\r")
  })
})

describe("StdinSanitizer", () => {
  it("passes ordinary typing straight through", () => {
    const san = newSanitizer()
    expect(san.push("hey")).toBe("hey")
    expect(san.push("\r")).toBe("\r")
    expect(san.push("\n")).toBe("\n")
    expect(san.holding).toBe(false)
    san.dispose()
  })

  it("forwards a complete paste pair verbatim", () => {
    const san = newSanitizer()
    const chunk = `${PASTE_START}line 1\nline 2${PASTE_END}`
    expect(san.push(chunk)).toBe(chunk)
    expect(san.holding).toBe(false)
    san.dispose()
  })

  it("reassembles a pair split across chunks", () => {
    const san = newSanitizer()
    expect(san.push(`${PASTE_START}he`)).toBe("")
    expect(san.holding).toBe(true)
    expect(san.push(`y${PASTE_END}`)).toBe(`${PASTE_START}hey${PASTE_END}`)
    expect(san.holding).toBe(false)
    san.dispose()
  })

  it("detects an end marker straddling held + incoming chunk", () => {
    const san = newSanitizer()
    expect(san.push(`${PASTE_START}a\x1b[20`)).toBe("")
    expect(san.push("1~")).toBe(`${PASTE_START}a${PASTE_END}`)
    san.dispose()
  })

  it("releases a stray paste body as plain input on flushHeld", () => {
    const san = newSanitizer()
    expect(san.push(PASTE_START)).toBe("")
    expect(san.holding).toBe(true)
    // Everything after a stray start is hostage until flush — the exact
    // pre-fix bug — but flushHeld frees it with markers stripped.
    expect(san.push("hey\r")).toBe("")
    expect(san.flushHeld()).toBe("hey\r")
    expect(san.holding).toBe(false)
    san.dispose()
  })

  it("strips nested markers when releasing a stray body", () => {
    const san = newSanitizer()
    expect(san.push(`${PASTE_START}a${PASTE_START}b`)).toBe("")
    expect(san.flushHeld()).toBe("ab")
    san.dispose()
  })

  it("flushHeld is idempotent after release", () => {
    const san = newSanitizer()
    san.push(PASTE_START)
    san.flushHeld()
    expect(san.flushHeld()).toBe("")
    expect(san.holding).toBe(false)
    san.dispose()
  })

  it("strips a lone end marker instead of letting Ink type it", () => {
    const san = newSanitizer()
    expect(san.push(`x${PASTE_END}y`)).toBe("xy")
    san.dispose()
  })

  it("holds a trailing start fragment and completes the pair next chunk", () => {
    const san = newSanitizer()
    expect(san.push("\x1b[200")).toBe("")
    expect(san.pendingPartial).toBe(true)
    expect(san.push(`~hey${PASTE_END}`)).toBe(`${PASTE_START}hey${PASTE_END}`)
    expect(san.pendingPartial).toBe(false)
    san.dispose()
  })

  it("drops a truncated start stanza on flushPartial (Ink would hold it)", () => {
    const san = newSanitizer()
    san.push("\x1b[200")
    expect(san.flushPartial()).toBe("")
    expect(san.pendingPartial).toBe(false)
    san.dispose()
  })

  it("drops a truncated end stanza on flushPartial (Ink would park on it)", () => {
    const san = newSanitizer()
    san.push("\x1b[201")
    expect(san.flushPartial()).toBe("")
    expect(san.pendingPartial).toBe(false)
    san.dispose()
  })

  it("releases a lone ESC fragment untouched for Ink's escape handling", () => {
    const san = newSanitizer()
    san.push("\x1b")
    expect(san.flushPartial()).toBe("\x1b")
    expect(san.pendingPartial).toBe(false)
    san.dispose()
  })

  it("rewrites kpenter that arrives while a paste body is held", () => {
    const san = newSanitizer()
    san.push(PASTE_START)
    san.push(KPENTER)
    expect(san.flushHeld()).toBe("\r")
    san.dispose()
  })

  it("ignores empty chunks", () => {
    const san = newSanitizer()
    expect(san.push("")).toBe("")
    expect(san.holding).toBe(false)
    expect(san.pendingPartial).toBe(false)
    san.dispose()
  })
})
