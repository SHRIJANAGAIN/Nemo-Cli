/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { KeyId } from "./keys"

export interface KeybindingDefinition {
  readonly defaultKeys: KeyId[]
  readonly description: string
}

export type KeybindingsConfig = Record<string, KeyId[]>

export const DEFAULT_KEYBINDINGS: KeybindingsConfig = {
  "tui.input.submit": ["enter"],
  "tui.input.cancel": ["escape"],
  "tui.input.backspace": ["backspace"],
  "tui.input.deleteForward": ["delete"],
  "tui.input.deleteWordBackward": ["ctrl+w", "alt+backspace"],
  "tui.input.deleteWordForward": ["alt+d"],
  "tui.input.deleteToLineStart": ["ctrl+u"],
  "tui.input.deleteToLineEnd": ["ctrl+k"],
  "tui.input.moveCursorLeft": ["left", "ctrl+b"],
  "tui.input.moveCursorRight": ["right", "ctrl+f"],
  "tui.input.moveCursorWordLeft": ["alt+left", "ctrl+left", "alt+b"],
  "tui.input.moveCursorWordRight": ["alt+right", "ctrl+right", "alt+f"],
  "tui.input.moveToLineStart": ["home", "ctrl+home", "ctrl+a"],
  "tui.input.moveToLineEnd": ["end", "ctrl+end", "ctrl+e"],
  "tui.input.historyPrevious": ["up"],
  "tui.input.historyNext": ["down"],
  "tui.input.undo": ["ctrl+z"],
  "tui.input.redo": ["ctrl+r"],
  "tui.input.paste": ["ctrl+v"],
  "tui.input.copy": ["ctrl+c"],
  "tui.input.menu": ["ctrl+o"],
  "tui.input.clear": ["ctrl+l"],
  "tui.input.help": ["ctrl+h"],
  "tui.input.voice": ["ctrl+q"],
  "tui.input.points": ["ctrl+p"],
  "tui.input.memory": ["ctrl+m"],
  "tui.select.confirm": ["enter"],
  "tui.select.cancel": ["escape", "ctrl+c"],
  "tui.select.up": ["up"],
  "tui.select.down": ["down"],
  "tui.approval.approve": ["ctrl+a"],
  "tui.approval.deny": ["ctrl+x"],
  "tui.approval.expand": ["ctrl+o"],
  "tui.approval.toggleNotifications": ["ctrl+n"],
  "tui.slash.select": ["enter"],
  "tui.slash.close": ["escape"],
  "tui.notifications.toggle": ["ctrl+n"],
  "tui.approval.help": ["ctrl+h"],

  "tui.permission.toggle": ["ctrl+p", "ctrl+y"],

  "tui.permission.yolo": ["ctrl+y"],
}

export interface KeybindingRegistry {
  resolve(action: string): KeyId[] | undefined
  register(action: string, keys: KeyId[]): void
}

/**
 * An always-on global chord as rendered by BOTH /keymap and the which-key
 * overlay — the single source those two renderers draw from (each used to
 * keep its own hardcoded copy, and the copies had drifted apart: /keymap
 * knew Ctrl+E/Ctrl+R, the overlay knew "ctrl+k p").
 */
export interface GlobalShortcut {
  /** KeyId-style chord: one key, or a leader sequence like "ctrl+k p". */
  readonly keys: string
  readonly label: string
}

export const GLOBAL_SHORTCUTS: readonly GlobalShortcut[] = [
  { keys: "ctrl+k", label: "Which-key menu" },
  { keys: "ctrl+d", label: "Abort turn" },
  { keys: "ctrl+p", label: "Command palette" },
  { keys: "ctrl+k p", label: "Cycle permission mode" },
  { keys: "ctrl+c", label: "Interrupt (empty idle ×2 exits)" },
  { keys: "ctrl+s", label: "Inject draft to front of queue" },
  { keys: "ctrl+g", label: "Subagents panel" },
  { keys: "ctrl+b", label: "Background tasks panel" },
  { keys: "ctrl+o", label: "Expand/collapse tool output" },
  { keys: "shift+tab", label: "Toggle plan mode" },
  { keys: "ctrl+e", label: "Enhance prompt" },
  { keys: "ctrl+r", label: "Edit last prompt" },
  { keys: "ctrl+x", label: "Clear queued prompts" },
  { keys: "ctrl+z", label: "Undo checkpoint" },
  { keys: "ctrl+y", label: "Redo checkpoint" },
]

/** The /keymap system message: "keys label" pairs, two-space separated. */
export function formatKeymapMessage(shortcuts: readonly GlobalShortcut[] = GLOBAL_SHORTCUTS): string {
  return shortcuts.map((s) => `${s.keys} ${s.label}`).join("  ")
}

export function createKeybindingRegistry(config: KeybindingsConfig = DEFAULT_KEYBINDINGS): KeybindingRegistry {
  const bindings = new Map<string, KeyId[]>()

  for (const [action, keys] of Object.entries(config)) {
    bindings.set(action, keys)
  }

  return {
    resolve(action: string): KeyId[] | undefined {
      return bindings.get(action)
    },
    register(action: string, keys: KeyId[]): void {
      bindings.set(action, keys)
    },
  }
}
