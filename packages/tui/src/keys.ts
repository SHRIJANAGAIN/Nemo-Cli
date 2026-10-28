/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Nemo key handling: type-safe key IDs, terminal sequence decoding,
 * and keybinding matching.
 *
 * Designed after pi-main's keybinding architecture, adapted for nemo's
 * TUI layers (TerminalUI, PremiumTerminalUI, InkUI).
 */

type Letter =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z"
type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
type SymbolKey =
  | "`"
  | "-"
  | "="
  | "["
  | "]"
  | "\\"
  | ";"
  | "'"
  | ","
  | "."
  | "/"
  | "!"
  | "@"
  | "#"
  | "$"
  | "%"
  | "^"
  | "&"
  | "*"
  | "("
  | ")"
  | "_"
  | "+"
  | "|"
  | "~"
  | "{"
  | "}"
  | ":"
  | "<"
  | ">"
  | "?"
type SpecialKey =
  | "escape"
  | "esc"
  | "enter"
  | "return"
  | "tab"
  | "space"
  | "backspace"
  | "delete"
  | "insert"
  | "home"
  | "end"
  | "pageUp"
  | "pageDown"
  | "up"
  | "down"
  | "left"
  | "right"
  | "f1"
  | "f2"
  | "f3"
  | "f4"
  | "f5"
  | "f6"
  | "f7"
  | "f8"
  | "f9"
  | "f10"
  | "f11"
  | "f12"
type BaseKey = Letter | Digit | SymbolKey | SpecialKey
type ModifierName = "ctrl" | "shift" | "alt" | "super"
type ModifiedKeyId<Key extends string, Remaining extends ModifierName = ModifierName> = {
  [M in Remaining]: `${M}+${Key}` | `${M}+${ModifiedKeyId<Key, Exclude<Remaining, M>>}`
}[Remaining]

export type KeyId = BaseKey | ModifiedKeyId<BaseKey>

export const Key = {
  escape: "escape" as const,
  enter: "enter" as const,
  tab: "tab" as const,
  space: "space" as const,
  backspace: "backspace" as const,
  delete: "delete" as const,
  insert: "insert" as const,
  home: "home" as const,
  end: "end" as const,
  pageUp: "pageUp" as const,
  pageDown: "pageDown" as const,
  up: "up" as const,
  down: "down" as const,
  left: "left" as const,
  right: "right" as const,
  f1: "f1" as const,
  f2: "f2" as const,
  f3: "f3" as const,
  f4: "f4" as const,
  f5: "f5" as const,
  f6: "f6" as const,
  f7: "f7" as const,
  f8: "f8" as const,
  f9: "f9" as const,
  f10: "f10" as const,
  f11: "f11" as const,
  f12: "f12" as const,
  backtick: "`" as const,
  hyphen: "-" as const,
  equals: "=" as const,
  leftbracket: "[" as const,
  rightbracket: "]" as const,
  backslash: "\\" as const,
  semicolon: ";" as const,
  quote: "'" as const,
  comma: "," as const,
  period: "." as const,
  slash: "/" as const,
  ctrl: <K extends BaseKey>(key: K): KeyId => `ctrl+${key}` as KeyId,
  shift: <K extends BaseKey>(key: K): KeyId => `shift+${key}` as KeyId,
  alt: <K extends BaseKey>(key: K): KeyId => `alt+${key}` as KeyId,
  super: <K extends BaseKey>(key: K): KeyId => `super+${key}` as KeyId,
  ctrlShift: <K extends BaseKey>(key: K): KeyId => `ctrl+shift+${key}` as KeyId,
  ctrlAlt: <K extends BaseKey>(key: K): KeyId => `ctrl+alt+${key}` as KeyId,
} as const

const SYMBOL_KEYS = new Set([
  "`",
  "-",
  "=",
  "[",
  "]",
  "\\",
  ";",
  "'",
  ",",
  ".",
  "/",
  "!",
  "@",
  "#",
  "$",
  "%",
  "^",
  "&",
  "*",
  "(",
  ")",
  "_",
  "+",
  "|",
  "~",
  "{",
  "}",
  ":",
  "<",
  ">",
  "?",
])

const LEGACY_SEQUENCES: Record<string, string[]> = {
  up: ["\x1b[A", "\x1bOA"],
  down: ["\x1b[B", "\x1bOB"],
  right: ["\x1b[C", "\x1bOC"],
  left: ["\x1b[D", "\x1bOD"],
  home: ["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"],
  end: ["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"],
  insert: ["\x1b[2~"],
  delete: ["\x1b[3~"],
  pageUp: ["\x1b[5~", "\x1b[[5~"],
  pageDown: ["\x1b[6~", "\x1b[[6~"],
  f1: ["\x1bOP", "\x1b[11~", "\x1b[[A"],
  f2: ["\x1bOQ", "\x1b[12~", "\x1b[[B"],
  f3: ["\x1bOR", "\x1b[13~", "\x1b[[C"],
  f4: ["\x1bOS", "\x1b[14~", "\x1b[[D"],
  f5: ["\x1b[15~", "\x1b[[E"],
  f6: ["\x1b[17~"],
  f7: ["\x1b[18~"],
  f8: ["\x1b[19~"],
  f9: ["\x1b[20~"],
  f10: ["\x1b[21~"],
  f11: ["\x1b[23~"],
  f12: ["\x1b[24~"],
}

const LEGACY_SHIFT_SEQUENCES: Record<string, string[]> = {
  up: ["\x1b[a"],
  down: ["\x1b[b"],
  right: ["\x1b[c"],
  left: ["\x1b[d"],
}

const LEGACY_CTRL_SEQUENCES: Record<string, string[]> = {
  up: ["\x1bOa"],
  down: ["\x1bOb"],
  right: ["\x1bOc"],
  left: ["\x1bOd"],
}

const LEGACY_SEQUENCE_KEY_IDS: Record<string, KeyId> = {
  "\x1bOA": "up",
  "\x1bOB": "down",
  "\x1bOC": "right",
  "\x1bOD": "left",
  "\x1bOH": "home",
  "\x1bOF": "end",
  "\x1b[2~": "insert",
  "\x1b[3~": "delete",
  "\x1b[5~": "pageUp",
  "\x1b[6~": "pageDown",
  "\x1b[a": "shift+up",
  "\x1b[b": "shift+down",
  "\x1b[c": "shift+right",
  "\x1b[d": "shift+left",
  "\x1bOa": "ctrl+up",
  "\x1bOb": "ctrl+down",
  "\x1bOc": "ctrl+right",
  "\x1bOd": "ctrl+left",
  "\x1bOP": "f1",
  "\x1bOQ": "f2",
  "\x1bOR": "f3",
  "\x1bOS": "f4",
  "\x1b[11~": "f1",
  "\x1b[12~": "f2",
  "\x1b[13~": "f3",
  "\x1b[14~": "f4",
  "\x1b[[A": "f1",
  "\x1b[[B": "f2",
  "\x1b[[C": "f3",
  "\x1b[[D": "f4",
  "\x1b[[E": "f5",
  "\x1b[15~": "f5",
  "\x1b[17~": "f6",
  "\x1b[18~": "f7",
  "\x1b[19~": "f8",
  "\x1b[20~": "f9",
  "\x1b[21~": "f10",
  "\x1b[23~": "f11",
  "\x1b[24~": "f12",
}

function matchesLegacySequence(data: string, sequences: readonly string[]): boolean {
  return sequences.includes(data)
}

function matchesLegacyModifierSequence(data: string, key: string, modifier: number): boolean {
  if (modifier === 1) return matchesLegacySequence(data, LEGACY_SHIFT_SEQUENCES[key] ?? [])
  if (modifier === 4) return matchesLegacySequence(data, LEGACY_CTRL_SEQUENCES[key] ?? [])
  return false
}

function parseKeyId(
  keyId: string,
): { key: string; ctrl: boolean; shift: boolean; alt: boolean; super: boolean } | null {
  const parts = keyId.toLowerCase().split("+")
  const key = parts[parts.length - 1]
  if (!key) return null
  return {
    key,
    ctrl: parts.includes("ctrl"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
    super: parts.includes("super"),
  }
}

function rawCtrlChar(key: string): string | null {
  const code = key.toLowerCase().charCodeAt(0)
  if ((code >= 97 && code <= 122) || key === "[" || key === "\\" || key === "]" || key === "_") {
    return String.fromCharCode(code & 0x1f)
  }
  if (key === "-") return String.fromCharCode(31)
  return null
}

function isDigitKey(key: string): boolean {
  return key >= "0" && key <= "9"
}

export function matchesKey(data: string, keyId: KeyId): boolean {
  const parsed = parseKeyId(keyId)
  if (!parsed) return false

  const { key, ctrl, shift, alt, super: superModifier } = parsed
  let modifier = 0
  if (shift) modifier |= 1
  if (alt) modifier |= 2
  if (ctrl) modifier |= 4
  if (superModifier) modifier |= 8

  switch (key) {
    case "escape":
    case "esc":
      if (modifier !== 0) return false
      return data === "\x1b" || matchesLegacySequence(data, LEGACY_SEQUENCES.escape ?? [])
    case "enter":
    case "return":
      if (modifier === 0)
        return data === "\r" || data === "\n" || matchesLegacySequence(data, LEGACY_SEQUENCES.enter ?? [])
      return matchesLegacyModifierSequence(data, "enter", modifier)
    case "tab":
      if (modifier === 1) return data === "\x1b[Z" || matchesLegacySequence(data, LEGACY_SHIFT_SEQUENCES.tab ?? [])
      if (modifier === 0) return data === "\t" || matchesLegacySequence(data, LEGACY_SEQUENCES.tab ?? [])
      return matchesLegacyModifierSequence(data, "tab", modifier)
    case "space":
      if (modifier === 0) return data === " "
      if (modifier === 4) return data === "\x00"
      if (modifier === 2) return data === "\x1b "
      return false
    case "backspace":
      if (modifier === 0) return data === "\x7f" || data === "\x08"
      if (modifier === 2) return data === "\x1b\x7f" || data === "\x1b\b"
      if (modifier === 4) return data === "\x08"
      return false
    case "delete":
      if (modifier === 0) return matchesLegacySequence(data, LEGACY_SEQUENCES.delete ?? [])
      return matchesLegacyModifierSequence(data, "delete", modifier)
    case "insert":
      if (modifier === 0) return matchesLegacySequence(data, LEGACY_SEQUENCES.insert ?? [])
      return matchesLegacyModifierSequence(data, "insert", modifier)
    case "home":
      if (modifier === 0) return matchesLegacySequence(data, LEGACY_SEQUENCES.home ?? [])
      return matchesLegacyModifierSequence(data, "home", modifier)
    case "end":
      if (modifier === 0) return matchesLegacySequence(data, LEGACY_SEQUENCES.end ?? [])
      return matchesLegacyModifierSequence(data, "end", modifier)
    case "pageup":
    case "pageUp":
      if (modifier === 0) return matchesLegacySequence(data, LEGACY_SEQUENCES.pageUp ?? [])
      return matchesLegacyModifierSequence(data, "pageUp", modifier)
    case "pagedown":
    case "pageDown":
      if (modifier === 0) return matchesLegacySequence(data, LEGACY_SEQUENCES.pageDown ?? [])
      return matchesLegacyModifierSequence(data, "pageDown", modifier)
    case "up":
      if (modifier === 0) return matchesLegacySequence(data, LEGACY_SEQUENCES.up ?? [])
      if (modifier === 2) return data === "\x1bp" || matchesLegacySequence(data, LEGACY_SHIFT_SEQUENCES.up ?? [])
      if (modifier === 4) return matchesLegacySequence(data, LEGACY_CTRL_SEQUENCES.up ?? [])
      return false
    case "down":
      if (modifier === 0) return matchesLegacySequence(data, LEGACY_SEQUENCES.down ?? [])
      if (modifier === 2) return data === "\x1bn" || matchesLegacySequence(data, LEGACY_SHIFT_SEQUENCES.down ?? [])
      if (modifier === 4) return matchesLegacySequence(data, LEGACY_CTRL_SEQUENCES.down ?? [])
      return false
    case "left":
      if (modifier === 0) return matchesLegacySequence(data, LEGACY_SEQUENCES.left ?? [])
      if (modifier === 2) return data === "\x1bb" || matchesLegacySequence(data, LEGACY_SHIFT_SEQUENCES.left ?? [])
      if (modifier === 4) return matchesLegacySequence(data, LEGACY_CTRL_SEQUENCES.left ?? [])
      return false
    case "right":
      if (modifier === 0) return matchesLegacySequence(data, LEGACY_SEQUENCES.right ?? [])
      if (modifier === 2) return data === "\x1bf" || matchesLegacySequence(data, LEGACY_SHIFT_SEQUENCES.right ?? [])
      if (modifier === 4) return matchesLegacySequence(data, LEGACY_CTRL_SEQUENCES.right ?? [])
      return false
    case "f1":
    case "f2":
    case "f3":
    case "f4":
    case "f5":
    case "f6":
    case "f7":
    case "f8":
    case "f9":
    case "f10":
    case "f11":
    case "f12":
      if (modifier !== 0) return false
      return matchesLegacySequence(data, LEGACY_SEQUENCES[key] ?? [])
  }

  if (key.length === 1 && ((key >= "a" && key <= "z") || isDigitKey(key) || SYMBOL_KEYS.has(key))) {
    const rawCtrl = rawCtrlChar(key)

    if (modifier === 6 && rawCtrl) {
      if (data === `\x1b${rawCtrl}`) return true
    }

    if (modifier === 2 && ((key >= "a" && key <= "z") || isDigitKey(key) || SYMBOL_KEYS.has(key))) {
      if (data === `\x1b${key}`) return true
    }

    if (modifier === 4 && rawCtrl) {
      if (data === rawCtrl) return true
    }

    if (modifier === 5 && rawCtrl) {
      if (data === rawCtrl) return true
    }

    if (modifier === 1 && key >= "a" && key <= "z") {
      if (data === key.toUpperCase()) return true
    }

    if (modifier !== 0) {
      return false
    }

    return data === key
  }

  return false
}

export function parseKey(data: string): string | undefined {
  const legacy = LEGACY_SEQUENCE_KEY_IDS[data]
  if (legacy) return legacy

  if (data === "\x1b") return "escape"
  if (data === "\t") return "tab"
  if (data === "\r" || data === "\n") return "enter"
  if (data === "\x00") return "ctrl+space"
  if (data === " ") return "space"
  if (data === "\x7f") return "backspace"
  if (data === "\x08") return "backspace"
  if (data === "\x1b[Z") return "shift+tab"
  if (data === "\x1b\x7f" || data === "\x1b\b") return "alt+backspace"
  if (data === "\x1b[A") return "up"
  if (data === "\x1b[B") return "down"
  if (data === "\x1b[C") return "right"
  if (data === "\x1b[D") return "left"
  if (data === "\x1b[H" || data === "\x1bOH") return "home"
  if (data === "\x1b[F" || data === "\x1bOF") return "end"
  if (data === "\x1b[3~") return "delete"
  if (data === "\x1b[5~") return "pageUp"
  if (data === "\x1b[6~") return "pageDown"

  if (data.length === 1) {
    const code = data.charCodeAt(0)
    if (code >= 1 && code <= 26) {
      return `ctrl+${String.fromCharCode(code + 96)}`
    }
    if (code >= 32 && code <= 126) {
      return data
    }
  }

  return undefined
}
