/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Port of the Trayambak Code reference `key_hint.rs`
 * -- KeyBinding, ShortcutHint, key matching with C0 control-char
 * compatibility, display labels, and constructor helpers.
 */

export type KeyCode =
  | { kind: "Char"; ch: string }
  | "Enter"
  | "Escape"
  | "Tab"
  | "Backspace"
  | "Space"
  | "Up"
  | "Down"
  | "Left"
  | "Right"
  | "PageUp"
  | "PageDown"
  | "Home"
  | "End"
  | "Delete"
  | "Insert"
  | "F"

export type KeyModifiers = {
  ctrl: boolean
  alt: boolean
  shift: boolean
}

export const NONE: KeyModifiers = { ctrl: false, alt: false, shift: false }
export const CTRL: KeyModifiers = { ctrl: true, alt: false, shift: false }
export const ALT: KeyModifiers = { ctrl: false, alt: true, shift: false }
export const SHIFT: KeyModifiers = { ctrl: false, alt: false, shift: true }
export const CTRL_ALT: KeyModifiers = { ctrl: true, alt: true, shift: false }

export type KeyEventKind = "Press" | "Release" | "Repeat"

export type KeyEvent = {
  code: KeyCode
  modifiers: KeyModifiers
  kind: KeyEventKind
}

export type KeyBinding = {
  key: KeyCode
  modifiers: KeyModifiers
}

export type ShortcutHint =
  | { kind: "Single"; binding: KeyBinding }
  | {
      kind: "Chord"
      prefix: KeyBinding
      completion: KeyBinding
    }

const CTRL_PREFIX = "ctrl + "
const SHIFT_PREFIX = "shift + "
const ALT_PREFIX = "alt + "

export function normalizeKeyParts(key: KeyCode, modifiers: KeyModifiers): { key: KeyCode; modifiers: KeyModifiers } {
  if (typeof key === "object" && key.kind === "Char") {
    const ch = key.ch
    if (modifiers === NONE && ch.length === 1) {
      const ctrlChar = c0ControlCharToCtrlChar(ch)
      if (ctrlChar !== null) {
        return {
          key: { kind: "Char", ch: ctrlChar },
          modifiers: { ...NONE, ctrl: true },
        }
      }
    }
    if (ch.length === 1 && ch >= "A" && ch <= "Z") {
      return {
        key: { kind: "Char", ch: ch.toLowerCase() },
        modifiers: { ...modifiers, shift: true },
      }
    }
  }
  return { key, modifiers }
}

function c0ControlCharToCtrlChar(ch: string): string | null {
  if (ch.length !== 1) return null
  const code = ch.charCodeAt(0)
  if (code === 0x00) return " "
  if (code >= 0x01 && code <= 0x1a) return String.fromCharCode(code - 0x01 + "a".charCodeAt(0))
  if (code >= 0x1c && code <= 0x1f) return String.fromCharCode(code - 0x1c + "4".charCodeAt(0))
  return null
}

export function isPress(binding: KeyBinding, event: KeyEvent): boolean {
  const nb = normalizeKeyParts(binding.key, binding.modifiers)
  const ne = normalizeKeyParts(event.code, event.modifiers)
  return (
    nb.key === ne.key &&
    nb.modifiers.ctrl === ne.modifiers.ctrl &&
    nb.modifiers.alt === ne.modifiers.alt &&
    nb.modifiers.shift === ne.modifiers.shift &&
    (event.kind === "Press" || event.kind === "Repeat")
  )
}

export function isPressed(bindings: KeyBinding[], event: KeyEvent): boolean {
  return bindings.some((b) => isPress(b, event))
}

export function isPlainTextKeyEvent(event: KeyEvent): boolean {
  if (typeof event.code === "object" && event.code.kind === "Char") {
    const ch = event.code.ch
    if (ch.length === 1 && ch.charCodeAt(0) < 0x20) return false
    if (event.modifiers.ctrl) return false
    if (event.modifiers.alt) return false
    return true
  }
  return false
}

export function hasCtrlOrAlt(mods: KeyModifiers): boolean {
  return (mods.ctrl || mods.alt) && !isAltGr(mods)
}

export function isAltGr(mods: KeyModifiers): boolean {
  return mods.alt && mods.ctrl
}

export function displayLabel(binding: KeyBinding): string {
  const mods = binding.modifiers
  const parts: string[] = []
  if (mods.ctrl) parts.push(CTRL_PREFIX)
  if (mods.shift) parts.push(SHIFT_PREFIX)
  if (mods.alt) parts.push(ALT_PREFIX)

  const key = binding.key
  let keyStr: string
  if (typeof key === "string") {
    switch (key) {
      case "Enter":
        keyStr = "enter"
        break
      case "Space":
        keyStr = "space"
        break
      case "Up":
        keyStr = "up"
        break
      case "Down":
        keyStr = "down"
        break
      case "Left":
        keyStr = "left"
        break
      case "Right":
        keyStr = "right"
        break
      case "PageUp":
        keyStr = "pgup"
        break
      case "PageDown":
        keyStr = "pgdn"
        break
      default:
        keyStr = key.toLowerCase()
    }
  } else if (typeof key === "object" && key.kind === "Char") {
    keyStr = key.ch
  } else {
    keyStr = String(key)
  }

  return parts.join("") + keyStr
}

export function shortcutDisplayLabel(hint: ShortcutHint): string {
  switch (hint.kind) {
    case "Single":
      return displayLabel(hint.binding)
    case "Chord":
      return displayLabel(hint.prefix) + " " + displayLabel(hint.completion)
  }
}

export function shortcutIsPress(hint: ShortcutHint, event: KeyEvent): boolean {
  switch (hint.kind) {
    case "Single":
      return isPress(hint.binding, event)
    case "Chord":
      return false
  }
}

export function plain(key: KeyCode): KeyBinding {
  return { key, modifiers: NONE }
}

export function ctrl(key: KeyCode): KeyBinding {
  return { key, modifiers: CTRL }
}

export function alt(key: KeyCode): KeyBinding {
  return { key, modifiers: ALT }
}

export function shift(key: KeyCode): KeyBinding {
  return { key, modifiers: SHIFT }
}

export function ctrlAlt(key: KeyCode): KeyBinding {
  return { key, modifiers: CTRL_ALT }
}
