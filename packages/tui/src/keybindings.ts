/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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
