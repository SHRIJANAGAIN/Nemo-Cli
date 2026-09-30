/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { Tui, Rect } from "../tui/terminal"

export interface ChatMessageEntry {
  role: "user" | "assistant" | "system"
  content: string
  toolCalls?: ToolCallEntry[]
}

export interface ToolCallEntry {
  name: string
  args: Record<string, unknown>
  result?: string
  error?: boolean
  running?: boolean
}

export interface ChatWidgetOptions {
  tui: Tui
  rect: Rect
}

/**
 * ChatWidget renders the scrollable message stream in the upper portion
 * of the terminal, including assistant text, tool-call spans, and streaming.
 *
 * Ported from TRAYAMBAK TUI `chatwidget.rs`  adapted for the Trayambak Terminal
 * abstraction.
 */
export class ChatWidget {
  private readonly tui: Tui
  private rect: Rect
  private messages: ChatMessageEntry[] = []
  private scrollOffset = 0
  private toolCallLine = 0

  constructor(options: ChatWidgetOptions) {
    this.tui = options.tui
    this.rect = options.rect
  }

  setRect(rect: Rect): void {
    this.rect = rect
  }

  getRect(): Rect {
    return { ...this.rect }
  }

  getMessages(): readonly ChatMessageEntry[] {
    return this.messages
  }

  addMessage(entry: ChatMessageEntry): void {
    this.messages.push(entry)
    this.scrollToBottom()
  }

  appendToLastMessage(delta: string): void {
    if (this.messages.length === 0) return
    const last = this.messages[this.messages.length - 1]
    last.content += delta
    this.scrollToBottom()
  }

  toolCallStarted(name: string, args: Record<string, unknown>): void {
    const activeLine = `${name} running`
    this.toolCallLine = this.messages.length
    const last = this.messages[this.messages.length - 1]
    if (last && last.role === "assistant" && last.toolCalls) {
      last.toolCalls.push({ name, args, running: true })
      this.scrollToBottom()
    }
    this.tui.write(activeLine)
  }

  toolCallCompleted(name: string, result: string, error = false): void {
    const status = error ? "[x]" : "[ok]"
    const last = this.messages[this.messages.length - 1]
    if (last && last.role === "assistant" && last.toolCalls) {
      const call = last.toolCalls.find((tc) => tc.name === name && tc.running)
      if (call) {
        call.result = result
        call.error = error
        call.running = false
      }
    }
    const statusLine = `${status} ${name}`
    this.tui.write(statusLine)
    if (result) {
      this.tui.write(result)
    }
    this.scrollToBottom()
  }

  scrollToBottom(): void {
    this.scrollOffset = 0
  }

  scrollUp(lines: number): void {
    this.scrollOffset = Math.min(this.scrollOffset + lines, this.messages.length)
  }

  scrollDown(lines: number): void {
    this.scrollOffset = Math.max(this.scrollOffset - lines, 0)
  }

  clear(): void {
    this.messages = []
    this.scrollOffset = 0
  }

  render(): void {
    const { height } = this.tui.getSize()
    const visibleHeight = Math.max(this.rect.height, height - this.rect.y)
    const startIndex = Math.max(0, this.messages.length - visibleHeight - this.scrollOffset)
    const visibleMessages = this.messages.slice(startIndex)

    this.tui.draw((frame) => {
      const { viewport } = frame
      const x = Math.max(this.rect.x, viewport.x)
      const y = Math.max(this.rect.y, viewport.y)
      const w = Math.min(this.rect.width, viewport.width - x)
      const h = Math.min(visibleHeight, viewport.height - y)

      let currentY = y
      for (const msg of visibleMessages) {
        if (currentY >= y + h) break
        const roleLabel = msg.role === "user" ? "You" : "Trayambak"
        const prefix = msg.role === "user" ? "\x1b[36m" : "\x1b[32m"
        const lines = this.wrapText(`${roleLabel}: ${msg.content}`, w)
        for (const line of lines) {
          if (currentY >= y + h) break
          this.tui.write(`\x1b[${currentY + 1};${x + 1}H${prefix}${line}\x1b[0m`)
          currentY++
        }
        if (msg.toolCalls && currentY < y + h) {
          for (const tc of msg.toolCalls) {
            if (currentY >= y + h) break
            const status = tc.running ? "\x1b[33m" : tc.error ? "\x1b[31m" : "\x1b[32m"
            const tcLine = tc.running ? `${tc.name} running` : tc.error ? `[x] ${tc.name}` : `[ok] ${tc.name}`
            this.tui.write(`\x1b[${currentY + 1};${x + 1}H${status}${tcLine}\x1b[0m`)
            currentY++
            if (tc.result && currentY < y + h) {
              const resultLines = this.wrapText(tc.result, w)
              for (const rl of resultLines) {
                if (currentY >= y + h) break
                this.tui.write(`\x1b[${currentY + 1};${x + 1}H${tc.error ? "\x1b[31m" : "\x1b[37m"}${rl}\x1b[0m`)
                currentY++
              }
            }
          }
        }
      }
    })
    this.tui.flush()
  }

  private wrapText(text: string, width: number): string[] {
    const words = text.split(" ")
    const lines: string[] = []
    let current = ""
    for (const word of words) {
      if (current.length + word.length + 1 <= width) {
        current += (current ? " " : "") + word
      } else {
        if (current) lines.push(current)
        current = word
      }
    }
    if (current) lines.push(current)
    return lines.length > 0 ? lines : [""]
  }
}
