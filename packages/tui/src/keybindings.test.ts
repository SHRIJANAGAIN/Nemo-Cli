/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { DEFAULT_KEYBINDINGS, GLOBAL_SHORTCUTS, createKeybindingRegistry, formatKeymapMessage } from "./keybindings.js"

describe("createKeybindingRegistry", () => {
  it("resolves the default composer/select/approval actions", () => {
    const reg = createKeybindingRegistry()
    expect(reg.resolve("tui.input.submit")).toEqual(["enter"])
    expect(reg.resolve("tui.select.cancel")).toEqual(["escape", "ctrl+c"])
    expect(reg.resolve("tui.input.deleteWordBackward")).toEqual(["ctrl+w", "alt+backspace"])
  })

  it("returns undefined for unknown actions", () => {
    expect(createKeybindingRegistry().resolve("nope.unknown")).toBeUndefined()
  })

  it("register overrides one action without touching the others", () => {
    const reg = createKeybindingRegistry()
    reg.register("tui.input.submit", ["ctrl+j"])
    expect(reg.resolve("tui.input.submit")).toEqual(["ctrl+j"])
    expect(reg.resolve("tui.input.cancel")).toEqual(["escape"])
  })

  it("isolates registries built from a custom config from the defaults", () => {
    const custom = createKeybindingRegistry({ "only.action": ["x"] })
    expect(custom.resolve("only.action")).toEqual(["x"])
    expect(custom.resolve("tui.input.submit")).toBeUndefined()
    expect(createKeybindingRegistry().resolve("tui.input.submit")).toEqual(["enter"])
  })

  it("covers every default action with at least one key", () => {
    for (const [action, keys] of Object.entries(DEFAULT_KEYBINDINGS)) {
      expect(keys.length, action).toBeGreaterThan(0)
    }
  })
})

describe("GLOBAL_SHORTCUTS", () => {
  it("has unique chords (no duplicate documentation rows)", () => {
    const keys = GLOBAL_SHORTCUTS.map((s) => s.keys)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("documents every chord with a non-empty label", () => {
    for (const s of GLOBAL_SHORTCUTS) {
      expect(s.keys.trim(), s.keys).not.toBe("")
      expect(s.label.trim(), s.keys).not.toBe("")
    }
  })

  it("formatKeymapMessage joins keys+label pairs with two spaces", () => {
    const msg = formatKeymapMessage([
      { keys: "ctrl+a", label: "One" },
      { keys: "ctrl+b", label: "Two" },
    ])
    expect(msg).toBe("ctrl+a One  ctrl+b Two")
  })

  it("the real /keymap message carries the entries both old copies disagreed on", () => {
    const msg = formatKeymapMessage()
    expect(msg).toContain("ctrl+e Enhance prompt") // was only in /keymap
    expect(msg).toContain("ctrl+r Edit last prompt") // was only in /keymap
    expect(msg).toContain("ctrl+k p Cycle permission mode") // was only in which-key
    expect(msg).toContain("ctrl+d Abort turn")
  })
})
