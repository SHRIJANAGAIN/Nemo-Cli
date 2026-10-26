/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, afterEach } from "vitest"
import { StdinSanitizer } from "./stdin-sanitizer.js"
import { onMouseScroll, type MouseScrollDir } from "./mouse-input.js"

/**
 * Mouse reporting (enabled by App: SGR 1000+1006) turns clicks and wheel
 * notches into byte sequences on stdin. Ink's key parser must never see
 * them (it would type them into the composer); the sanitizer strips every
 * report, re-emits wheel direction for transcript scrollback, and never
 * releases a half-parsed CSI fragment.
 */
describe("mouse reports in stdin (SGR1006 + legacy X10)", () => {
  const subs: Array<() => void> = []
  const listen = (): MouseScrollDir[] => {
    const dirs: MouseScrollDir[] = []
    subs.push(onMouseScroll((d) => dirs.push(d)))
    return dirs
  }

  afterEach(() => {
    while (subs.length > 0) subs.pop()?.()
  })

  it("strips SGR reports and emits wheel direction", () => {
    const dirs = listen()
    const s = new StdinSanitizer()
    expect(s.push("\x1b[<64;10;5M")).toBe("")
    expect(s.push("ab\x1b[<65;10;6Mcd")).toBe("abcd")
    expect(dirs).toEqual(["up", "down"])
  })

  it("swallows clicks/releases so they can never reach the composer", () => {
    listen()
    const s = new StdinSanitizer()
    expect(s.push("\x1b[<0;3;3M\x1b[<0;3;3m\x1b[<2;3;3M\x1b[<1;3;3M")).toBe("")
  })

  it("parks an incomplete report across chunks and reassembles it", () => {
    const dirs = listen()
    const s = new StdinSanitizer()
    expect(s.push("x\x1b[<64;10;5")).toBe("x")
    expect(s.push("M")).toBe("")
    expect(dirs).toEqual(["up"])
  })

  it("drops a never-completed mouse fragment instead of handing Ink half a CSI", () => {
    const s = new StdinSanitizer()
    expect(s.push("\x1b[<64;1")).toBe("")
    expect(s.flushPartial()).toBe("")
  })

  it("strips legacy X10 reports and maps the wheel bit", () => {
    const dirs = listen()
    const s = new StdinSanitizer()
    expect(s.push("\x1b[M`!!")).toBe("") // 96 = 64|32 → wheel up
    expect(s.push("\x1b[Ma!!")).toBe("") // 97 = 65|32 → wheel down
    expect(dirs).toEqual(["up", "down"])
  })

  it("leaves ordinary input untouched", () => {
    listen()
    const s = new StdinSanitizer()
    expect(s.push("hello\r")).toBe("hello\r")
    expect(s.push("\x1b[A")).toBe("\x1b[A")
  })
})
