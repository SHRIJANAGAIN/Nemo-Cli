/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Portions derived from OpenAI Codex CLI (codex-rs), Copyright 2025 OpenAI,
 * licensed under the Apache License, Version 2.0. See THIRD_PARTY_NOTICES.md.
 */

import { Tui, Rect } from "../tui/terminal"

export interface ComposerOptions {
  tui: Tui
  rect: Rect
}

export interface ComposerInputResult {
  text: string
  isCommand: boolean
  command?: string
  args?: string
}

/**
 * Composer manages the bottom input pane: text input, slash-command entry,
 * and suggestion display.
 *
 * Ported from Codex TUI `bottom_pane.rs`  adapted for the Nemo Terminal
 * abstraction.
 */
export class Composer {
  private readonly tui: Tui
  private rect: Rect
  private inputBuffer: string = ""
  private placeholder: string = "/ask ?? ??? ????..."
  private suggestions: string[] = []
  private focused = true

  constructor(options: ComposerOptions) {
    this.tui = options.tui
    this.rect = options.rect
  }

  setRect(rect: Rect): void {
    this.rect = rect
  }

  getRect(): Rect {
    return { ...this.rect }
  }

  getFocused(): boolean {
    return this.focused
  }

  setFocused(focused: boolean): void {
    this.focused = focused
  }

  getPlaceholder(): string {
    return this.placeholder
  }

  setPlaceholder(text: string): void {
    this.placeholder = text
  }

  getSuggestions(): string[] {
    return this.suggestions
  }

  setSuggestions(suggestions: string[]): void {
    this.suggestions = suggestions
  }

  appendChar(ch: string): void {
    this.inputBuffer += ch
    this.render()
  }

  backspace(): void {
    this.inputBuffer = this.inputBuffer.slice(0, -1)
    this.render()
  }

  clear(): void {
    this.inputBuffer = ""
    this.render()
  }

  getInput(): string {
    return this.inputBuffer
  }

  setInput(text: string): void {
    this.inputBuffer = text
    this.render()
  }

  reset(): void {
    this.inputBuffer = ""
    this.suggestions = []
    this.render()
  }

  render(): void {
    const { width } = this.tui.getSize()
    const x = Math.max(this.rect.x, 0)
    const y = Math.max(this.rect.y, 0)
    const w = Math.min(this.rect.width, width - x)
    const inputText = this.inputBuffer || this.placeholder
    const displayText = inputText.length > w - 2 ? inputText.slice(0, w - 2) + "" : inputText
    const prefix = this.inputBuffer[0] === "/" ? "\x1b[33m" : "\x1b[37m"
    const display = this.inputBuffer ? prefix + displayText + "\x1b[0m" : "\x1b[90m" + displayText + "\x1b[0m"

    this.tui.draw((frame) => {
      const { viewport } = frame
      const dx = Math.max(x, viewport.x)
      const dy = Math.max(y, viewport.y)
      const dw = Math.min(w, viewport.width - dx)

      // Clear the input line
      const blank = " ".repeat(dw)
      this.tui.write(`\x1b[${dy + 1};${dx + 1}H${blank}`)
      this.tui.write(`\x1b[${dy + 1};${dx + 1}H${display}`)
    })
    this.tui.flush()
  }
}
