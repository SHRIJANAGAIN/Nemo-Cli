/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from "vitest"
import { CTRL_C_EXIT_WINDOW_MS, isEnter, resolveCtrlCPress } from "./keys.js"

describe("isEnter", () => {
  it("accepts CR via Ink's key.return", () => {
    expect(isEnter("\r", { return: true })).toBe(true)
    expect(isEnter("", { return: true })).toBe(true)
  })

  it("accepts LF terminals where key.return is false", () => {
    expect(isEnter("\n", { return: false })).toBe(true)
  })

  it("accepts bare CR without the flag", () => {
    expect(isEnter("\r", { return: false })).toBe(true)
  })

  it("rejects normal characters", () => {
    expect(isEnter("a", { return: false })).toBe(false)
    expect(isEnter(" ", { return: false })).toBe(false)
    expect(isEnter("/hi", { return: false })).toBe(false)
  })

  it("rejects escape/tab sequences even if mis-flagged", () => {
    expect(isEnter("\u001b", { return: false })).toBe(false)
    expect(isEnter("\t", { return: false })).toBe(false)
  })
})

describe("resolveCtrlCPress", () => {
  it("aborts the running turn (never exits mid-turn)", () => {
    expect(resolveCtrlCPress({ running: true, hasDraft: false, dialogOpen: false })).toBe("abort")
    expect(resolveCtrlCPress({ running: true, hasDraft: true, dialogOpen: false })).toBe("abort")
  })

  it("denies open dialogs instead of killing the session", () => {
    expect(resolveCtrlCPress({ running: false, hasDraft: false, dialogOpen: true })).toBe("deny-dialog")
  })

  it("clears a non-empty draft instead of arming exit", () => {
    expect(resolveCtrlCPress({ running: false, hasDraft: true, dialogOpen: false, nowMs: 1000 })).toBe("clear-draft")
  })

  it("arms on first idle press, exits on second inside the window", () => {
    expect(resolveCtrlCPress({ running: false, hasDraft: false, dialogOpen: false, nowMs: 1000 })).toBe("arm")
    expect(
      resolveCtrlCPress({
        running: false,
        hasDraft: false,
        dialogOpen: false,
        lastPressAtMs: 1000,
        nowMs: 1000 + CTRL_C_EXIT_WINDOW_MS,
      }),
    ).toBe("exit")
  })

  it("re-arms (no exit) once the window lapses", () => {
    expect(
      resolveCtrlCPress({
        running: false,
        hasDraft: false,
        dialogOpen: false,
        lastPressAtMs: 1000,
        nowMs: 1000 + CTRL_C_EXIT_WINDOW_MS + 1,
      }),
    ).toBe("arm")
  })
})
