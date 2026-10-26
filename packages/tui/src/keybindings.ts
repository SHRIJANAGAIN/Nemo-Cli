/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { KeyId } from "./keys.js"

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
  // Approval chords were wrong here until 2026-10-03: this table claimed
  // ctrl+a / ctrl+x, but PermissionOverlay.tsx never reads a modifier — it
  // accepts bare letters and Escape (lines 96-130). The chords below are the
  // keys the overlay actually dispatches on, verified against that file.
  // The load-bearing invariant is Escape: it denies ABOVE the composerHasText
  // guard, so a half-typed draft can never swallow the one key that always
  // means "no". Do not "tidy" these into chords the overlay does not handle.
  "tui.approval.approve": ["enter", "y"],
  "tui.approval.deny": ["n", "escape"],
  "tui.approval.approveAlways": ["a"],
  "tui.approval.approveSession": ["s"],
  "tui.approval.denyAlways": ["x"],
  "tui.approval.up": ["up"],
  "tui.approval.down": ["down"],
  "tui.approval.expand": ["ctrl+o"],
  "tui.approval.toggleNotifications": ["ctrl+n"],
  "tui.slash.select": ["enter"],
  "tui.slash.close": ["escape"],
  "tui.notifications.toggle": ["ctrl+n"],
  "tui.approval.help": ["ctrl+h"],

  "tui.permission.toggle": ["ctrl+p", "ctrl+y"],

  "tui.permission.yolo": ["ctrl+y"],

  // Global chords, mirroring GLOBAL_SHORTCUTS below — same file, one source.
  // These are the chords App.tsx actually dispatches on (verified against its
  // handler at the 2938-2991 block); the ids above that shared a name with a
  // different behaviour (tui.input.redo was ctrl+r but Ctrl+R edits the last
  // prompt; tui.input.points was ctrl+p but Ctrl+P opens the palette) are why
  // the global set gets its own namespace rather than reusing those.
  "tui.global.whichKey": ["ctrl+k"],
  "tui.global.abort": ["ctrl+d"],
  "tui.global.palette": ["ctrl+p"],
  "tui.global.interrupt": ["ctrl+c"],
  "tui.global.injectDraft": ["ctrl+s"],
  "tui.global.subagents": ["ctrl+g"],
  "tui.global.backgroundTasks": ["ctrl+b"],
  "tui.global.toggleOutput": ["ctrl+o"],
  "tui.global.planMode": ["shift+tab"],
  "tui.global.enhance": ["ctrl+e"],
  "tui.global.editLast": ["ctrl+r"],
  "tui.global.clearQueue": ["ctrl+x"],
  "tui.global.undo": ["ctrl+z"],
  "tui.global.redo": ["ctrl+y"],
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
  /**
   * The keymap action this shortcut fires, when there is a 1:1 one.
   *
   * Present so a renderer can show the chord the user actually has rather than
   * the shipped default. Leader sequences ("ctrl+k p") deliberately have no
   * action: `Keymap` matches single chords only, so there is nothing to
   * substitute and claiming otherwise would let a rebind silently not apply.
   */
  readonly action?: string
}

export const GLOBAL_SHORTCUTS: readonly GlobalShortcut[] = [
  { keys: "ctrl+k", label: "Which-key menu", action: "tui.global.whichKey" },
  { keys: "ctrl+d", label: "Abort turn", action: "tui.global.abort" },
  { keys: "ctrl+p", label: "Command palette", action: "tui.global.palette" },
  { keys: "ctrl+k p", label: "Cycle permission mode" },
  { keys: "ctrl+c", label: "Interrupt (empty idle ×2 exits)", action: "tui.global.interrupt" },
  { keys: "ctrl+s", label: "Inject draft to front of queue", action: "tui.global.injectDraft" },
  { keys: "ctrl+g", label: "Subagents panel", action: "tui.global.subagents" },
  { keys: "ctrl+b", label: "Background tasks panel", action: "tui.global.backgroundTasks" },
  { keys: "ctrl+o", label: "Expand/collapse tool output", action: "tui.global.toggleOutput" },
  { keys: "shift+tab", label: "Toggle plan mode", action: "tui.global.planMode" },
  { keys: "ctrl+e", label: "Enhance prompt", action: "tui.global.enhance" },
  { keys: "ctrl+r", label: "Edit last prompt", action: "tui.global.editLast" },
  { keys: "ctrl+x", label: "Clear queued prompts", action: "tui.global.clearQueue" },
  { keys: "ctrl+z", label: "Undo checkpoint", action: "tui.global.undo" },
  { keys: "ctrl+y", label: "Redo checkpoint", action: "tui.global.redo" },
  // Composer-local, but the user has to be told they exist: ↑/↓ recall is read
  // by PromptInput through these two action ids, and a feature no screen lists
  // is a feature nobody finds.
  { keys: "up", label: "Recall previous prompt", action: "tui.input.historyPrevious" },
  { keys: "down", label: "Recall newer prompt", action: "tui.input.historyNext" },
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
