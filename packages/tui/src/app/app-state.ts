/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { Tui, Rect, TerminalSize } from "../tui/terminal"
import { ChatWidget, type ToolCallEntry } from "../chatwidget/chat-widget"
import { Composer } from "../bottom_pane/composer"
import { AppEvent, ExitMode, AppExitInfo } from "./events"

export interface AppStateOptions {
  tui: Tui
  cwd?: string
}

/**
 * AppState is the top-level orchestrator for the Trayambak TUI.
 *
 * It owns the ChatWidget and Composer panes, routes AppEvents to the
 * appropriate component, and tracks the global lifecycle (token budget,
 * exit reason, etc.). Ported from TRAYAMBAK TUI `app.rs` logic and adapted
 * for the Trayambak Terminal abstraction.
 */
export class AppState {
  private readonly tui: Tui
  private cwd: string
  private chatWidget: ChatWidget
  private composer: Composer
  private exitInfo: AppExitInfo | null = null
  private pendingToolCalls = new Map<string, ToolCallEntry>()
  private totalTokens = 0

  constructor(options: AppStateOptions) {
    this.tui = options.tui
    this.cwd = options.cwd ?? process.cwd()

    const size: TerminalSize = this.tui.getSize()
    const chatRect: Rect = { x: 0, y: 0, width: size.width, height: size.height - 3 }
    const composerRect: Rect = { x: 0, y: size.height - 3, width: size.width, height: 3 }

    this.chatWidget = new ChatWidget({ tui: this.tui, rect: chatRect })
    this.composer = new Composer({ tui: this.tui, rect: composerRect })
  }

  getChatWidget(): ChatWidget {
    return this.chatWidget
  }

  getComposer(): Composer {
    return this.composer
  }

  handleEvent(event: AppEvent): void {
    switch (event.type) {
      case "Init":
        this.render()
        break
      case "Render":
        this.render()
        break
      case "ResizeEvent":
        this.layout(event.width, event.height)
        this.render()
        break
      case "KeyEvent":
        this.handleKey(event.key, event.code, event.modifiers)
        break
      case "UserInputEvent":
        this.handleUserInput(event.text)
        break
      case "ThreadStartedEvent":
        this.chatWidget.addMessage({
          role: "assistant",
          content: "Trayambak agent started...",
        })
        this.render()
        break
      case "AgentMessageDeltaEvent":
        this.chatWidget.appendToLastMessage(event.delta)
        this.render()
        break
      case "AgentMessageCompletedEvent":
        this.totalTokens += this.estimateTokens()
        this.render()
        break
      case "ToolCallStarted":
        this.chatWidget.toolCallStarted(event.toolName, event.args)
        this.render()
        break
      case "ToolCallCompleted":
        this.chatWidget.toolCallCompleted(event.toolName, event.result, event.error)
        this.render()
        break
      case "NotificationEvent":
        this.showNotification(event.notification)
        break
      case "Exit":
        this.exitInfo = {
          exitReason: { kind: event.mode, message: undefined },
          tokenUsage: { totalTokens: this.totalTokens },
        }
        this.tui.exit()
        break
      case "Shutdown":
        this.tui.exit()
        break
      default:
        break
    }
  }

  private handleKey(key: string, _code: number, _modifiers: number): void {
    if (key === "q" || key === "\x03") {
      this.handleEvent({ type: "Exit", mode: "user_requested" })
    } else if (key === "\r" || key === "\n") {
      const input = this.composer.getInput()
      if (input) {
        this.handleEvent({ type: "UserInputEvent", text: input })
        this.composer.reset()
      }
    } else if (key === "\x7f" || key === "\b") {
      this.composer.backspace()
      this.render()
    } else if (key.length === 1 && key >= " " && key <= "~") {
      this.composer.appendChar(key)
    }
  }

  private handleUserInput(text: string): void {
    if (text.startsWith("/")) {
      this.handleSlashCommand(text)
    } else {
      this.chatWidget.addMessage({ role: "user", content: text })
      this.render()
    }
  }

  private handleSlashCommand(input: string): void {
    const parts = input.slice(1).split(" ")
    const command = parts[0]
    const args = parts.slice(1).join(" ")
    this.handleEvent({
      type: "SlashCommandEvent",
      command,
      args,
    })
  }

  private showNotification(notification: { title: string; body: string; level: "info" | "warning" | "error" }): void {
    const colorMap: Record<string, string> = {
      info: "\x1b[36m",
      warning: "\x1b[33m",
      error: "\x1b[31m",
    }
    const color = colorMap[notification.level] ?? "\x1b[0m"
    const { width } = this.tui.getSize()
    const blank = " ".repeat(width)
    this.tui.write(`\x1b[${width};1H${color}${notification.title}: ${notification.body}\x1b[0m`)
    this.tui.write(`\x1b[${width};1H${blank}`)
  }

  private layout(width: number, height: number): void {
    const chatRect: Rect = { x: 0, y: 0, width, height: height - 3 }
    const composerRect: Rect = { x: 0, y: height - 3, width, height: 3 }
    this.chatWidget.setRect(chatRect)
    this.composer.setRect(composerRect)
  }

  private render(): void {
    this.tui.clear()
    this.chatWidget.render()
    this.composer.render()
  }

  private estimateTokens(): number {
    const msgs = this.chatWidget.getMessages()
    let count = 0
    for (const msg of msgs) {
      count += Math.ceil(msg.content.length / 4)
    }
    return count
  }

  getExitInfo(): AppExitInfo | null {
    return this.exitInfo
  }

  getTotalTokens(): number {
    return this.totalTokens
  }

  getCwd(): string {
    return this.cwd
  }

  setExitInfo(info: AppExitInfo): void {
    this.exitInfo = info
  }

  exit(mode: ExitMode = "normal"): void {
    this.exitInfo = {
      exitReason: { kind: mode },
      tokenUsage: { totalTokens: this.totalTokens },
    }
    this.tui.exit()
  }
}
