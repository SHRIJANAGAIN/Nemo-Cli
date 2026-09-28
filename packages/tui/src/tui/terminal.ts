/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { EventEmitter } from "events"

export interface TerminalSize {
  width: number
  height: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Frame {
  size: TerminalSize
  viewport: Rect
}

export type DrawCallback = (frame: Frame) => void

export interface TuiOptions {
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  alternateScreen?: boolean
  rawMode?: boolean
  onResize?: (size: TerminalSize) => void
}

export class Tui extends EventEmitter {
  private readonly stdin: NodeJS.ReadStream
  private readonly stdout: NodeJS.WriteStream
  private alternateScreen = false
  private rawMode = false
  private cursorVisible = true
  private size: TerminalSize
  private drawing = false
  private resizeListener?: (size: TerminalSize) => void

  constructor(options: TuiOptions = {}) {
    super()
    this.stdin = options.stdin ?? process.stdin
    this.stdout = options.stdout ?? process.stdout
    this.size = {
      width: this.stdout.columns || 80,
      height: this.stdout.rows || 24,
    }
    if (options.alternateScreen) {
      this.enterAltScreen()
    }
    if (options.rawMode) {
      this.enableRawMode()
    }
    if (options.onResize) {
      this.resizeListener = options.onResize
      this.stdout.on("resize", () => {
        this.size = {
          width: this.stdout.columns || 80,
          height: this.stdout.rows || 24,
        }
        this.resizeListener?.(this.size)
      })
    }
  }

  getSize(): TerminalSize {
    return { ...this.size }
  }

  write(text: string): void {
    this.stdout.write(text)
  }

  enterAltScreen(): void {
    if (this.alternateScreen) return
    this.stdout.write("\x1b[?1049h")
    this.alternateScreen = true
  }

  leaveAltScreen(): void {
    if (!this.alternateScreen) return
    this.stdout.write("\x1b[?1049l")
    this.alternateScreen = false
  }

  enableRawMode(): void {
    if (this.rawMode) return
    this.stdin.setRawMode?.(/*mode*/ true)
    this.stdin.resume()
    this.stdin.setEncoding("utf8")
    this.rawMode = true
  }

  disableRawMode(): void {
    if (!this.rawMode) return
    this.stdin.setRawMode?.(/*mode*/ false)
    this.stdin.pause()
    this.rawMode = false
  }

  showCursor(): void {
    if (!this.cursorVisible) {
      this.stdout.write("\x1b[?25h")
      this.cursorVisible = true
    }
  }

  hideCursor(): void {
    if (this.cursorVisible) {
      this.stdout.write("\x1b[?25l")
      this.cursorVisible = false
    }
  }

  clear(): void {
    this.stdout.write("\x1b[2J\x1b[H")
  }

  draw(callback: DrawCallback): void {
    if (this.drawing) return
    this.drawing = true
    try {
      const frame: Frame = {
        size: this.getSize(),
        viewport: {
          x: 0,
          y: 0,
          width: this.size.width,
          height: this.size.height,
        },
      }
      callback(frame)
    } finally {
      this.drawing = false
    }
  }

  flush(): void {
    this.stdout.write("\x1b[0m")
  }

  exit(): void {
    this.leaveAltScreen()
    this.disableRawMode()
    this.showCursor()
    this.stdout.write("\x1b[?7h")
    this.removeAllListeners()
  }

  static restore(): void {
    try {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(/*mode*/ false)
      }
    } catch {
      // ignore
    }
    process.stdout.write("\x1b[?25h\x1b[?1049l\x1b[?7h")
  }
}
