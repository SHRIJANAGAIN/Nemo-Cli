/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

export type ShortcutAction =
  | "exit"
  | "stop_generation"
  | "undo"
  | "redo"
  | "menu"
  | "clear"
  | "history"
  | "voice"
  | "memory"
  | "paste"
  | "points"
  | "help"
  | "approve"
  | "deny"
  | "expand"
  | "permissions"

export interface KeyBinding {
  key: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  action: ShortcutAction
  description: string
}

export const DEFAULT_BINDINGS: KeyBinding[] = [
  { key: "c", ctrl: true, action: "stop_generation", description: "Stop AI generation / Exit" },
  { key: "d", ctrl: true, action: "exit", description: "Exit trayambak" },
  { key: "z", ctrl: true, action: "undo", description: "Undo last AI change" },
  { key: "y", ctrl: true, action: "redo", description: "Redo last undone change" },
  { key: "o", ctrl: true, action: "menu", description: "Open command menu" },
  { key: "l", ctrl: true, action: "clear", description: "Clear screen" },
  { key: "h", ctrl: true, action: "help", description: "Show all shortcuts" },
  { key: "v", ctrl: true, action: "paste", description: "Paste clipboard text" },
  { key: "p", ctrl: true, action: "permissions", description: "Toggle permission mode" },
  { key: "p", ctrl: true, shift: true, action: "points", description: "Show points & rewards" },
  { key: "q", ctrl: true, action: "voice", description: "Capture voice input" },
  { key: "e", ctrl: true, action: "memory", description: "Open memory" },
  { key: "a", ctrl: true, action: "approve", description: "Approve pending action" },
  { key: "x", ctrl: true, action: "deny", description: "Deny pending action" },
  { key: "n", ctrl: true, action: "expand", description: "Toggle notifications / expand" },
  { key: "o", ctrl: true, shift: true, action: "expand", description: "Expand last tool result" },
]

export function formatShortcut(b: KeyBinding): string {
  let mod = ""
  if (b.ctrl) mod += "Ctrl+"
  if (b.shift) mod += "Shift+"
  if (b.alt) mod += "Alt+"
  return `${mod}${b.key.toUpperCase()}`
}

export function getShortcutsHelp(): string {
  return DEFAULT_BINDINGS.map((b) => `  ${formatShortcut(b).padEnd(12)} ${b.description}`).join("\n")
}

export function parseKeypress(chunk: Buffer, bindings: KeyBinding[] = DEFAULT_BINDINGS): ShortcutAction | null {
  const code = chunk[0]
  if (code >= 1 && code <= 26) {
    const key = String.fromCharCode(code + 96)
    const withShift = bindings.find((b) => b.ctrl && b.shift && b.key === key)
    if (withShift) return withShift.action
    const match = bindings.find((b) => b.ctrl && !b.shift && b.key === key)
    return match?.action ?? null
  }
  if (code === 27) {
    const match = bindings.find((b) => b.key === "Escape")
    return match?.action ?? null
  }
  return null
}
