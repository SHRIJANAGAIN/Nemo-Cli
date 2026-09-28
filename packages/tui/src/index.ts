/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

// Full UI component library (theme system, boxes, spinners, toasts, footer, dialogs)

import * as child_process from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { stringWidth, graphemes, sliceByWidth } from "./ink-app/utils/stringWidth.js"
import { g } from "./ink-app/glyphs.js"

export * from "./ui/index"

import { DEFAULT_NOTIFICATION_CONFIG, notifyForEvent } from "./notifications"

export * from "./approval-notification"

export function renderArtifact(
  artifact: { filename: string; language: string; content: string; version?: number },
  ui: TerminalUI,
): void {
  ui.separator()

  ui.line(
    ui.c(
      "cyan",
      ui.c(
        "bold",
        `📄 ${artifact.filename}${artifact.version ? ` (v${artifact.version})` : ""} [${artifact.language}]`,
      ),
    ),
  )

  ui.separator()

  const lines = artifact.content.split("\n")

  for (const line of lines) {
    ui.line(line)
  }

  ui.separator()
}

export function renderDesignComponent(dc: { filename: string; content: string }, ui: TerminalUI): void {
  ui.separator()

  ui.line(ui.c("magenta", ui.c("bold", `🎨 Design Component: ${dc.filename}`)))

  ui.line(ui.c("dim", "Live preview available in browser. Open the .dc.html file to view."))

  ui.separator()

  const lines = dc.content.split("\n")

  for (const line of lines) {
    ui.line(line)
  }

  ui.separator()
}

export function renderCitation(citation: { text: string; source: string; url?: string }, ui: TerminalUI): void {
  const source = citation.url ? `${citation.source} (${citation.url})` : citation.source

  ui.line(`${ui.c("dim", "[" + source + "]")} ${ui.c("cyan", citation.text)}`)
}

export function renderVerification(
  report: {
    passed: boolean
    steps: Array<{ name: string; status: "pass" | "fail" | "skip"; duration?: number; detail?: string }>
  },
  ui: TerminalUI,
): void {
  ui.separator()

  ui.line(ui.c("bold", "🔍 Verification Control"))

  ui.line("")

  for (const step of report.steps) {
    const icon = step.status === "pass" ? g("ok") : step.status === "fail" ? g("fail") : g("ring")

    const color = step.status === "pass" ? "green" : step.status === "fail" ? "red" : "dim"

    const detail = step.detail ? ` ${ui.c("dim", "- " + step.detail)}` : ""

    const duration = step.duration ? ` (${step.duration}ms)` : ""

    ui.line(`  ${icon} ${ui.c(color, step.name)}${duration}${detail}`)
  }

  ui.line("")

  const passCount = report.steps.filter((s) => s.status === "pass").length

  const failCount = report.steps.filter((s) => s.status === "fail").length

  const skipCount = report.steps.filter((s) => s.status === "skip").length

  const summary = `${g("ok")} ${passCount}/${report.steps.length} pass, ${failCount} fail, ${skipCount} skip`

  ui.line(ui.c(report.passed ? "green" : "red", summary))

  ui.separator()
}

import type { AgentEvent, TextPart } from "../../protocol/src/index"

import {
  renderSplitLogo,
  renderStartupLoading,
  renderStatusDialog,
  renderStatusBar,
  renderFileChange,
  getTheme,
} from "./dialogs"

import { PALETTE, bullet, title, outputLine, treePrefix } from "./ui/tool-palette"

export const COLOR = {
  reset: "\x1b[0m",

  dim: "\x1b[2m",

  bold: "\x1b[1m",

  italic: "\x1b[3m",

  underline: "\x1b[4m",

  red: "\x1b[31m",

  green: "\x1b[32m",

  yellow: "\x1b[33m",

  blue: "\x1b[34m",

  magenta: "\x1b[35m",

  cyan: "\x1b[36m",

  white: "\x1b[37m",

  black: "\x1b[30m",

  skyBlue: "\x1b[94m",

  brightGreen: "\x1b[92m",

  bgRed: "\x1b[41m",

  bgGreen: "\x1b[42m",

  bgYellow: "\x1b[43m",

  bgBlue: "\x1b[44m",

  bgMagenta: "\x1b[45m",

  bgCyan: "\x1b[46m",

  bgWhite: "\x1b[47m",

  bgBrightRed: "\x1b[101m",

  bgBrightGreen: "\x1b[102m",
}

const RAINBOW_BG: Array<keyof typeof COLOR> = ["bgRed", "bgYellow", "bgGreen", "bgCyan", "bgBlue", "bgMagenta"]

const SHIMMER_FRAMES = ["*", "+", "x", "+", "·", "∘", "○", "◎", "◉", "●", "◉", "◎", "○", "∘", "·"]

const THINKING_SPINNER = [
  "✻",
  "✼",
  "✺",
  "✹",
  "✸",
  "✷",
  "✶",
  "✵",
  "✴",
  "✳",
  "✲",
  "✱",
  "✰",
  "✦",
  "✧",
  "✪",
  "✫",
  "✬",
  "✭",
  "✮",
]

const THINKING_RAINBOW: Array<keyof typeof COLOR> = [
  "red",
  "yellow",
  "green",
  "cyan",
  "blue",
  "magenta",
  "skyBlue",
  "brightGreen",
  "cyan",
  "blue",
  "magenta",
]

const TOOL_COLORS: Array<keyof typeof COLOR> = ["blue", "cyan", "green", "red", "blue", "skyBlue"]

const TYPE_FRAMES = ["|", "/", "-", "\\"]

/** Strip ANSI escape sequences so we can measure visible string length. */

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

export interface TerminalUIOptions {
  useColor?: boolean

  premium?: boolean
}

export class TerminalUI {
  /** Restore terminal state: re-enable line wrap and show the cursor. */

  static restoreTerminal(): void {
    process.stdout.write("\x1b[?7h\x1b[?25h")
  }

  private colors: boolean

  private premium: boolean

  private buffer = ""

  private inToolBlock = false

  private thinkingBuffer = ""

  private thinkingOpen = false

  private thinkingLineCount = 0

  private assistantStarted = false

  private lastThinkingChunk = ""

  private lastThinkingFlat = ""

  private lastThinkingAt = 0

  private lastThinkingRender = 0

  private shimmerFrame = 0

  private toolFrame = 0

  private toolTimer: NodeJS.Timeout | null = null

  private toolHungNotified = false

  private toolStartedAt = 0

  private activeToolLine = ""

  private typeTimer: NodeJS.Timeout | null = null

  private promptAnimTimer: NodeJS.Timeout | null = null

  private lastWasRule = false

  private lastToolResult: { name: string; text: string; isError: boolean; lines: number } | null = null
  private permissionMode: "read-only" | "ask" | "auto-approve" | "full-access" = "ask"
  private assistantInCodeBlock = false
  private footerText = ""
  private streamingText = ""
  private streamingCursorVisible = true
  private streamingTimer: NodeJS.Timeout | null = null
  private stopHookSuffix = ""

  private streamingRenderedLength = 0

  private lastStreamChunk = ""
  private tokenBudget: { used: number; limit: number } | null = null
  private apiMetrics: { ttft: number; otps: number } | null = null
  public transcriptActive = false
  private transcriptBuffer: string[] = []
  private permissionPromptActive = false
  private permissionPromptResolve: ((value: string | null) => void) | null = null
  private structuredToolCalls: Array<{
    id: string
    name: string
    arguments: Record<string, unknown>
    status: "running" | "done" | "error"
    result?: { stdout?: string; stderr?: string; exitCode?: number; error?: string }
    durationMs?: number
    text?: string
  }> = []

  private toolStartTimes: Map<string, number> = new Map()

  private workflowState: "idle" | "starting" | "running" | "streaming" | "paused" | "error" | "completed" | "failed" =
    "idle"

  private loadingTimer: NodeJS.Timeout | null = null

  private progressTimer: NodeJS.Timeout | null = null

  private animationFrames: Array<() => void> = []

  private errorDisplayTimer: NodeJS.Timeout | null = null

  constructor(options: TerminalUIOptions = {}) {
    this.colors = options.useColor ?? process.stdout.isTTY

    this.premium = options.premium ?? false
  }

  public c(key: string | keyof typeof COLOR, text: string): string {
    if (!this.colors) return text

    const code = COLOR[key as keyof typeof COLOR]

    return code ? `${code}${text}${COLOR.reset}` : text
  }

  write(text: string): void {
    process.stdout.write(text)
  }

  line(text = ""): void {
    this.lastWasRule = false

    process.stdout.write(text + "\n")
  }

  /**

   * Print a centered, boxed "popup" panel — used to announce tool calls and

   * surface their results with the same visual weight as a modal. The box is

   * sized to the terminal width and clipped so it never wraps unexpectedly.

   */

  popup(title: string, lines: string[], accent: keyof typeof COLOR = "cyan"): void {
    if (!this.colors || !process.stdout.isTTY) {
      this.line(this.c(accent, this.c("bold", ` ${title} `)))

      for (const l of lines) this.line(l)

      this.line("")

      return
    }

    if (this.premium) {
      this.premiumPopup(title, lines)

      return
    }

    // Auto-size the box to the widest content line (capped to terminal width)

    // so tall ASCII art never gets clipped mid-row.

    const cols = process.stdout.columns ?? 120

    const widest = Math.max(...lines.map((l) => stripAnsi(l).replace(/\uFEFF/g, "").length), title.length + 2, 20)

    const inner = Math.min(widest, cols - 4)

    const w = inner + 2

    const top = `┌${"─".repeat(w)}┐`

    const bot = `└${"─".repeat(w)}┘`

    const titleText = ` ${title} `

    const pad = Math.max(0, w - titleText.length - 2)

    const titleRow = `│${this.c(accent, this.c("bold", titleText))}${"─".repeat(pad)}│`

    const strip = (s: string): string => {
      const visible = stripAnsi(s).replace(/\uFEFF/g, "")

      if (visible.length > inner) {
        // Hard-clip long art lines so the right border stays intact.

        let out = ""

        let used = 0

        for (const ch of s) {
          const w1 = stripAnsi(ch).replace(/\uFEFF/g, "").length

          if (used + w1 > inner) break

          out += ch

          used += w1
        }

        return `│ ${out}${" ".repeat(Math.max(0, inner - used))} │`
      }

      const pad2 = Math.max(0, inner - visible.length)

      return `│ ${s}${" ".repeat(pad2)} │`
    }

    this.line(top)

    this.line(titleRow)

    for (const l of lines) this.line(strip(l))

    this.line(bot)

    this.line("")
  }

  private premiumPopup(title: string, lines: string[]): void {
    const t = getTheme()

    const width = Math.min(
      88,
      Math.max(title.length + 12, ...lines.map((l) => stripAnsi(l).replace(/\uFEFF/g, "").length + 8)),
    )

    const borderColor = t.primary

    const titleColor = t.accent

    const top = `${borderColor}╔${"═".repeat(width)}╗${COLOR.reset}`

    const titleText = ` ${title} `

    const titlePad = width - titleText.length - 2

    const titleLeft = Math.max(1, Math.floor(titlePad / 2))

    const titleRow = `${borderColor}║${COLOR.reset}${" ".repeat(titleLeft)}${titleColor}${COLOR.bold}${titleText}${COLOR.reset}${" ".repeat(titlePad - titleLeft)}${borderColor}║${COLOR.reset}`

    this.line("")

    this.line(" ".repeat(1) + COLOR.dim + "▁".repeat(width + 2) + COLOR.reset)

    this.line(top)

    this.line(titleRow)

    this.line(`${borderColor}║${COLOR.reset}${" ".repeat(width)}${borderColor}║${COLOR.reset}`)

    for (const line of lines) {
      const vis = stripAnsi(line).replace(/\uFEFF/g, "").length

      const pad = Math.max(0, width - vis - 2)

      this.line(`${borderColor}║${COLOR.reset} ${line}${" ".repeat(pad)} ${borderColor}║${COLOR.reset}`)
    }

    this.line(`${borderColor}║${COLOR.reset}${" ".repeat(width)}${borderColor}║${COLOR.reset}`)

    const bot = `${borderColor}╚${"═".repeat(width)}╝${COLOR.reset}`

    this.line(bot)

    this.line(" ".repeat(1) + COLOR.dim + "▁".repeat(width + 2) + COLOR.reset)

    this.line("")
  }

  /** Clear the screen and move cursor home so each turn starts on a fresh frame. */

  clearScreen(): void {
    this.lastWasRule = false

    process.stdout.write("\x1b[2J\x1b[H")
  }

  /** Clear the previous line and move the cursor up one row. */

  clearPreviousLine(): void {
    this.lastWasRule = false

    process.stdout.write("\x1b[1A\x1b[2K")
  }

  banner(text: string): void {
    this.write(this.c("blue", this.c("bold", "TRAYAMBAK")))

    this.write("  ")

    this.line(this.c("dim", text))
  }

  /** Sky-blue ====>> rule with a bright-green SKT STC CODE tag. */

  stcRule(): void {
    const equals = "=".repeat(38)

    if (this.colors) {
      this.line(`${COLOR.skyBlue}${equals}>>${COLOR.reset} ${COLOR.brightGreen}${COLOR.bold}SKT STC CODE${COLOR.reset}`)
    } else {
      this.line(`${equals}>> SKT STC CODE`)
    }
  }

  /** Type a line character-by-character with a shimmering cursor (never wraps). */

  async typedLine(text: string, color: keyof typeof COLOR = "blue", delayMs = 8): Promise<void> {
    if (!this.colors || !process.stdout.isTTY) {
      this.line(text)

      return
    }

    // Clip to one terminal row so \r-frames never wrap onto a second line.

    const cols = Math.max(20, (process.stdout.columns ?? 100) - 2)

    // Width-aware + grapheme-safe: `.length` over-counted Indic marks (Hindi
    // got clipped well short of `cols`) and slicing by UTF-16 index stranded
    // a matra from its base mid-animation.
    const plain = stripAnsi(text)
    const clipped = stringWidth(plain) > cols ? sliceByWidth(plain, cols - 1) + "…" : text

    // Reveal GRAPHEME by grapheme: stepping UTF-16 indexes cut matras off
    // their base (a Hindi base flashed, then its mark appeared late).
    const parts = graphemes(clipped)

    let frame = 0

    for (let i = 1; i <= parts.length; i++) {
      const glyph = TYPE_FRAMES[frame % TYPE_FRAMES.length]

      process.stdout.write(
        `\r${COLOR[color]}${COLOR.bold}${parts.slice(0, i).join("")}${COLOR.reset}${COLOR.cyan}${glyph}${COLOR.reset}\x1b[K`,
      )

      frame++

      await new Promise((r) => setTimeout(r, delayMs))
    }

    process.stdout.write(`\r${COLOR[color]}${COLOR.bold}${clipped}${COLOR.reset}\x1b[K\n`)
  }

  async shimmerLine(text: string, cycles = 5, frameMs = 120): Promise<void> {
    if (!this.colors || !process.stdout.isTTY) {
      this.line(text)

      return
    }

    const palette: (keyof typeof COLOR)[] = ["red", "white", "green", "yellow", "white", "magenta"]

    const total = Math.max(1, cycles) * palette.length

    for (let i = 0; i < total; i++) {
      const accent = palette[i % palette.length]

      process.stdout.write(`\r${COLOR[accent]}${COLOR.bold}${text}${COLOR.reset}\x1b[K`)

      await new Promise((r) => setTimeout(r, frameMs))
    }

    process.stdout.write(`\r${COLOR.red}${COLOR.bold}${text}${COLOR.reset}\x1b[K\n`)
  }

  headline(text: string): void {
    this.line(this.c("blue", this.c("bold", text)))
  }

  logo(art: string, scale = 0.5): void {
    for (const line of scaleAscii(art, scale).split("\n")) this.line(this.c("dim", line))
  }

  /**

   * Shrink an ASCII-art block: keep every `1/scale`-th line and trim each

   * line to ~2/3 of its width so startups do not drown the terminal.

   */

  /** Render a 3-letter ASCII block word with a blue gradient (middle = blue). */

  /** Render an ASCII block word in a left-red / middle-blue / right-magenta split. */

  threeColorLogo(art: string): void {
    const lines = art.split("\n")

    const width = Math.max(...lines.map((l) => l.length))

    const left = Math.floor(width * 0.3)

    const right = Math.floor(width * 0.7)

    for (const line of lines) {
      let out = ""

      for (let col = 0; col < line.length; col++) {
        const ch = line[col]

        if (ch === " ") {
          out += " "

          continue
        }

        const key: keyof typeof COLOR = col < left ? "red" : col < right ? "blue" : "magenta"

        out += this.c(key, ch)
      }

      this.line(out)
    }
  }

  gradientLogo(art: string, palette: Array<keyof typeof COLOR> = ["red", "blue", "magenta"]): void {
    const lines = art.split("\n")

    const width = Math.max(...lines.map((l) => l.length))

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      const segmentWidth = width / palette.length

      let out = ""

      for (let col = 0; col < line.length; col++) {
        const idx = Math.min(palette.length - 1, Math.floor(col / segmentWidth))

        const key = palette[idx]

        if (line[col] !== " ") out += this.c(key, line[col])
        else out += " "
      }

      this.line(out)
    }
  }

  userInput(text: string): void {
    this.line(this.c("dim", "> ") + text)
  }

  /** Close an in-flight thinking line (used before any other output). */

  private closeThinkingLine(): void {
    if (this.thinkingOpen) {
      process.stdout.write(COLOR.reset + "\x1b[K\n")

      this.thinkingOpen = false

      this.thinkingLineCount = 0
    }
  }

  assistantText(text: string): void {
    this.closeThinkingLine()
    if (!this.assistantStarted) {
      this.assistantStarted = true
    }
    this.lastWasRule = false
    const out = text.replace(/\n?```/g, "\n\n```")
    const lines = out.split("\n")
    const formatted: string[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith("```")) {
        this.assistantInCodeBlock = !this.assistantInCodeBlock
        formatted.push(this.c("green", this.c("dim", line)))
        continue
      }
      if (this.assistantInCodeBlock) {
        formatted.push(this.c("green", "  " + line))
        continue
      }
      if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line) || /^\s*\u2022\s+/.test(line)) {
        formatted.push(this.c("skyBlue", line))
        continue
      }
      if (/`([^`\n]+)`/.test(line)) {
        const withInline = line.replace(/`([^`\n]+)`/g, (_m: string, g1: string) => this.c("green", "`" + g1 + "`"))
        formatted.push(this.c("white", withInline))
        continue
      }
      formatted.push(this.c("white", line))
    }
    process.stdout.write(formatted.join("\n"))
  }

  flushAssistant(): void {
    if (this.assistantStarted) {
      process.stdout.write(COLOR.reset + "\n\n")

      this.assistantStarted = false

      this.lastWasRule = false
    }

    this.stopStreamingCursor()

    this.streamingText = ""
  }

  /** True when assistant text is still streaming (not yet flushed). */

  hasStreamedText(): boolean {
    return this.assistantStarted
  }

  /** True when the assistant bubble has started (mirrors hasStreamedText). */

  hasAssistantStarted(): boolean {
    return this.assistantStarted
  }

  /** Append raw text during streaming with clean terminal output. */
  streamAssistantText(chunk: string): void {
    this.closeThinkingLine()

    if (!this.assistantStarted) {
      this.assistantStarted = true
      this.lastWasRule = false
      this.streamingRenderedLength = 0
      this.lastStreamChunk = ""
    }

    if (!chunk) return
    this.streamingText += chunk
    process.stdout.write(chunk)
  }

  /** Finalize streamed text without double printing. */
  finalizeAssistantText(): void {
    if (!this.assistantStarted && !this.streamingText) return
    this.stopStreamingCursor()
    process.stdout.write(COLOR.reset + "\n\n")
    this.streamingText = ""
    this.streamingRenderedLength = 0
    this.lastStreamChunk = ""
    this.assistantStarted = false
    this.lastWasRule = false
  }

  /** Stop the streaming cursor animation. */

  private stopStreamingCursor(): void {
    if (this.streamingTimer) {
      clearInterval(this.streamingTimer)

      this.streamingTimer = null
    }

    this.streamingCursorVisible = false
  }

  /** Start blinking cursor for streaming text. */
  private startStreamingCursor(): void {
    // Keep one stable cursor while text is streaming. Repainting the whole
    // terminal line on a timer causes visible flicker in Windows ConPTY.
    if (this.streamingTimer) {
      clearInterval(this.streamingTimer)
      this.streamingTimer = null
    }
    this.streamingCursorVisible = true
  }

  /** Set stop-hook status suffix shown on the tool spinner. */

  setStopHookSuffix(suffix: string): void {
    this.stopHookSuffix = suffix
  }

  /** Show token budget in the status area. */

  showTokenBudget(used: number, limit: number): void {
    this.tokenBudget = { used, limit }

    const pct = limit > 0 ? Math.round((used / limit) * 100) : 0

    const color = pct > 80 ? "red" : pct > 50 ? "yellow" : "green"

    this.line(this.c("dim", "  token budget:") + " " + this.c(color, `${used} / ${limit} (${pct}%)`))
  }

  /** Show API performance metrics. */

  showApiMetrics(ttftMs: number, otps: number): void {
    this.apiMetrics = { ttft: ttftMs, otps }

    const ttft = this.c("cyan", `${ttftMs}ms`)

    const otpsStr = this.c("magenta", `${otps} tok/s`)

    this.line(this.c("dim", "  latency:") + ` ${ttft}  ${this.c("dim", "speed:")} ${otpsStr}`)
  }

  /** Render a structured tool call with named arguments. */

  toolCallStructured(id: string, name: string, args: Record<string, unknown>, text?: string): void {
    this.closeThinkingLine()

    this.stopToolSpinner()

    if (!this.toolStartTimes.has(id)) this.toolStartTimes.set(id, Date.now())

    const existing = this.structuredToolCalls.find((c) => c.id === id)

    if (existing) {
      existing.arguments = args

      existing.status = "running"

      if (text !== undefined) existing.text = text
    } else {
      this.structuredToolCalls.push({ id, name, arguments: args, status: "running", text })
    }

    this.renderStructuredToolCalls()
  }

  /** Render structured tool result. */

  toolResultStructured(
    id: string,
    result: { stdout?: string; stderr?: string; exitCode?: number; error?: string },
  ): void {
    const call = this.structuredToolCalls.find((c) => c.id === id)

    if (!call) return

    call.status = result.error ? "error" : "done"

    call.result = result

    call.durationMs = Date.now() - (this.toolStartedAtForId(call.id) ?? Date.now())

    this.renderStructuredToolCalls()
  }

  private toolStartedAtForId(id: string): number | undefined {
    return this.toolStartTimes.get(id)
  }

  private renderStructuredToolCalls(): void {
    if (this.structuredToolCalls.length === 0) return

    const cols = process.stdout.columns ?? 100

    const boxWidth = Math.min(88, Math.max(40, cols - 4))

    process.stdout.write(COLOR.reset + "\n")

    for (const call of this.structuredToolCalls) {
      const statusIcon = call.status === "running" ? "◉" : call.status === "error" ? "✖" : "✔"

      const statusColor = call.status === "running" ? "cyan" : call.status === "error" ? "red" : "green"

      const borderColor = statusColor

      const label = this.c(COLOR.bold, "tool_call")

      const namePart = this.c(COLOR[borderColor] + COLOR.bold, call.name)

      const header = `${COLOR[borderColor]}${statusIcon} ${label} · ${namePart}${COLOR.reset}`

      const top = `┌─ ${header}`

      this.line(top)

      this.line(`${COLOR.dim}${"─".repeat(Math.max(2, boxWidth - 1))}${COLOR.reset}`)

      const entries = Object.entries(call.arguments)

      const shownEntries = entries.length > 3 ? entries.slice(0, 3) : entries

      for (const [k, v] of shownEntries) {
        const kStr = String(k)

        const vStr = typeof v === "string" ? v : JSON.stringify(v)

        let valueLine = vStr

        if (valueLine.length > boxWidth - 12) {
          valueLine = valueLine.slice(0, boxWidth - 15) + "…"
        }

        this.line(
          `${COLOR.dim}│${COLOR.reset} ${COLOR.cyan}${kStr}${COLOR.reset} ${COLOR.dim}=${COLOR.reset} ${valueLine}`,
        )
      }

      if (entries.length > shownEntries.length) {
        this.line(
          `${COLOR.dim}│${COLOR.reset} ${COLOR.dim}... +${entries.length - shownEntries.length} more${COLOR.reset}`,
        )
      }

      this.line(`${COLOR.dim}└${"─".repeat(Math.max(2, boxWidth - 1))}${COLOR.reset}`)

      if (call.result) {
        const out = [call.result.stdout, call.result.stderr].filter(Boolean).join("\n").trim()

        const err = call.result.error?.trim()

        const body = err || out

        const exitCode = call.result.exitCode ?? "unknown"

        const exitColor = call.status === "error" ? "red" : "green"

        const exitLabel = call.status === "error" ? "✖ Error" : "✔ OK"

        this.line(`${COLOR[exitColor]}${exitLabel} exit=${exitCode}${COLOR.reset}`)

        if (body) {
          const lines = body.split("\n")

          const preview = lines.slice(0, 20).join("\n")

          const suffix = lines.length > 20 ? `\n${COLOR.dim}... (${lines.length} lines)${COLOR.reset}` : ""

          this.line(`${COLOR.dim}${preview}${COLOR.reset}${suffix}`)
        }
      }

      const elapsed =
        call.durationMs !== undefined ? ` ${COLOR.dim}· ${(call.durationMs / 1000).toFixed(1)}s${COLOR.reset}` : ""
      if (elapsed) this.line(elapsed)

      this.line("")
    }
  }

  /** Enter transcript mode: switch to alternate screen and render scrollable history. */

  enterTranscriptMode(messages: Array<{ role: string; content: string; timestamp?: number }>): void {
    if (this.transcriptActive) return

    this.transcriptActive = true

    this.transcriptBuffer = messages.map((m) => {
      const ts = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : ""

      const prefix = ts ? `[${ts}] ` : ""

      const role = m.role === "user" ? "You" : m.role === "assistant" ? "trayambak" : m.role

      return `${prefix}${role}: ${m.content}`
    })

    process.stdout.write("\x1b[?1049h\x1b[H")

    this.renderTranscript()
  }

  /** Exit transcript mode and restore normal screen. */

  exitTranscriptMode(): void {
    if (!this.transcriptActive) return

    this.transcriptActive = false

    process.stdout.write("\x1b[?1049l")

    this.transcriptBuffer = []
  }

  private renderTranscript(): void {
    if (!this.transcriptActive) return

    const cols = process.stdout.columns ?? 100

    const rows = process.stdout.rows ?? 40

    process.stdout.write("\x1b[H\x1b[2J")

    this.line(this.c("bold", "TRANSCRIPT"))

    this.separator()

    const visible = this.transcriptBuffer.slice(-rows + 4)

    for (const line of visible) {
      this.line(line.slice(0, cols))
    }

    this.line("")

    this.line(this.c("dim", "q = quit  ↑/↓ = scroll  / = search"))
  }

  /** Show an inline permission prompt with choices. */

  async showPermissionPrompt(
    tool: string,
    reason: string,
    choices: Array<{ label: string; value: string }>,
  ): Promise<string | null> {
    if (this.permissionPromptActive) return null

    this.permissionPromptActive = true

    this.line("")

    this.line(this.c("yellow", this.c("bold", `? Approve ${tool}`)))

    if (reason) {
      this.line(this.c("dim", `  ${reason.slice(0, 200)}`))
    }

    const keys = ["y", "a", "d", "x", "n"]

    for (let i = 0; i < choices.length; i++) {
      const hk = i < keys.length ? ` [${keys[i]}]` : ""

      this.line(`  ${i + 1}. ${choices[i].label}${hk}`)
    }

    this.line(this.c("dim", "  enter = select · esc = cancel"))

    const result = await this.pickMenu(
      "",
      "",
      choices.map((c) => ({ value: c.value, description: c.label })),
    )

    this.permissionPromptActive = false

    return result
  }

  /** Show session resume list. */

  async showSessionResume(
    sessions: Array<{ id: string; title: string; date: string; messageCount?: number }>,
  ): Promise<string | null> {
    const options = sessions.map((s) => ({
      value: s.id,

      description: `${s.title} · ${s.date}${s.messageCount !== undefined ? ` · ${s.messageCount} msgs` : ""}`,
    }))

    return this.chooseOption("Resume session", options)
  }

  /** Show conversation rewind message selector. */

  async showConversationRewind(messages: Array<{ id: string; text: string; date?: string }>): Promise<string | null> {
    const options = messages.map((m) => ({
      value: m.id,

      description: m.text.slice(0, 80) + (m.text.length > 80 ? "…" : "") + (m.date ? ` · ${m.date}` : ""),
    }))

    return this.chooseOption("Restore message", options)
  }

  /**

   * Cycle a rotating hint line while the agent is idle. Returns a cleanup

   * function; no-ops when stdout is not a TTY or no hints are given.

   */

  rotatingHint(lines: string[], intervalMs = 1800): () => void {
    if (!process.stdout.isTTY || lines.length === 0) return () => {}

    let idx = 0

    process.stdout.write("\x1b[2m" + lines[idx] + "\x1b[0m")

    const timer = setInterval(() => {
      idx = (idx + 1) % lines.length

      process.stdout.write("\r\x1b[2m" + lines[idx] + "\x1b[0m\x1b[K")
    }, intervalMs) as unknown as NodeJS.Timeout

    return () => {
      clearInterval(timer)

      process.stdout.write("\r\x1b[K")
    }
  }

  /**

   * Thinking stream rendered as ONE in-place updating line with rainbow

   * shimmer, pulsing spinner, and animated glyph cycling. Newlines are

   * flattened to spaces: real newlines break the \r carriage-return overwrite

   * and stack duplicate lines on screen.

   */
  thinking(text: string): void {
    if (!text) return

    if (this.assistantStarted) return

    if (text === this.lastThinkingChunk && Date.now() - this.lastThinkingAt < 60) return

    this.lastThinkingChunk = text

    this.lastThinkingAt = Date.now()

    this.thinkingBuffer += text

    if (this.thinkingBuffer.length > 3072) this.thinkingBuffer = this.thinkingBuffer.slice(-3072)

    this.shimmerFrame = (this.shimmerFrame + 1) % SHIMMER_FRAMES.length

    const now = Date.now()

    if (now - this.lastThinkingRender < 80) return

    this.lastThinkingRender = now

    const t = this.premium ? getTheme() : null

    const spinnerIdx = Math.floor(this.shimmerFrame / 2) % THINKING_SPINNER.length

    const spinner = this.colors
      ? `${COLOR[THINKING_RAINBOW[spinnerIdx % THINKING_RAINBOW.length]]}${COLOR.bold}${THINKING_SPINNER[spinnerIdx]}${COLOR.reset}`
      : THINKING_SPINNER[spinnerIdx]

    const flat = this.thinkingBuffer.replace(/\s+/g, " ").trim()
    const cols = process.stdout.columns ?? 80
    const isSame = flat === this.lastThinkingFlat
    if (isSame && this.shimmerFrame % 3 !== 0) return
    this.lastThinkingFlat = flat

    const colorIdx = this.shimmerFrame % THINKING_RAINBOW.length

    const thinkingColor = this.colors ? (t ? t.accent : COLOR[THINKING_RAINBOW[colorIdx]]) : ""

    const reset = this.colors ? COLOR.reset : ""

    this.thinkingOpen = true

    this.lastWasRule = false

    const dots = ".".repeat((this.shimmerFrame % 3) + 1)

    const shownText = flat.length > cols - 18 ? flat.slice(0, Math.max(1, cols - 21)) + "…" : flat

    if (this.premium && t) {
      const gradientColors = [t.primary, t.secondary, t.accent]

      const colorIdx2 = this.shimmerFrame % gradientColors.length

      const textColor = this.c(gradientColors[colorIdx2], "") + COLOR.dim + COLOR.italic

      process.stdout.write(
        `\r\x1b[2K${spinner} ${textColor}Thinking…${COLOR.reset} ${this.c(t.muted, dots)} ${thinkingColor}${shownText}${reset}`,
      )
    } else {
      const textPart = this.colors
        ? `${thinkingColor}${COLOR.dim}${COLOR.italic}Thinking…${reset} ${thinkingColor}${dots}${reset}`
        : `Thinking${dots}`

      process.stdout.write(`\r\x1b[2K${spinner} ${textPart} ${thinkingColor}${shownText}${reset}`)
    }

    this.thinkingLineCount = 1
  }

  flushThinking(): void {
    this.thinkingBuffer = ""

    this.lastThinkingFlat = ""

    this.lastThinkingChunk = ""

    this.lastThinkingRender = 0

    this.closeThinkingLine()

    process.stdout.write("\n")
  }

  toolCall(name: string, args: unknown, stopHookSuffix = ""): void {
    this.closeThinkingLine()
    this.stopToolSpinner()
    this.stopHookSuffix = stopHookSuffix
    const a = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {}
    const key = a.path ?? a.command ?? a.pattern ?? a.query ?? a.url ?? ""
    let pretty = String(key ?? "")
    if (pretty === name) pretty = ""
    if (pretty.length > 120) pretty = pretty.slice(0, 120) + "…"
    const cols = process.stdout.columns ?? 100
    const maxLen = Math.max(20, cols - 30)
    if (pretty.length > maxLen) pretty = pretty.slice(0, maxLen) + "…"
    this.activeToolLine = `${name}${pretty ? "  " + pretty : ""}`
    this.inToolBlock = true
    this.toolStartedAt = Date.now()
    this.toolFrame = 0
    this.toolHungNotified = false
    this.renderToolFrame()
    this.startToolSpinner()
  }

  private startToolSpinner(): void {
    if (this.toolTimer) clearInterval(this.toolTimer as unknown as NodeJS.Timeout)
    if (!this.toolStartedAt || Date.now() - this.toolStartedAt > 500) this.toolStartedAt = Date.now()

    this.toolHungNotified = false

    this.stopHookSuffix = ""

    this.toolTimer = setInterval(() => {
      this.toolFrame = (this.toolFrame + 1) % TOOL_COLORS.length

      if (this.inToolBlock) this.renderToolFrame()

      if (Date.now() - this.toolStartedAt > 90000 && !this.toolHungNotified) {
        this.toolHungNotified = true

        process.stdout.write(COLOR.reset + "\x1b[K\n")

        this.line(this.c("dim", "[tool hung >90s - spinner auto-cleared, check output or ctrl+c]"))
      }

      if (Date.now() - this.toolStartedAt > 120000) {
        this.stopToolSpinner()

        this.inToolBlock = false

        process.stdout.write(COLOR.reset + "\n")
      }
    }, 120) as unknown as NodeJS.Timeout
  }
  private stopToolSpinner(): void {
    if (this.toolTimer) {
      clearInterval(this.toolTimer as unknown as NodeJS.Timeout)

      this.toolTimer = null

      this.toolHungNotified = false
    }

    this.stopHookSuffix = ""

    process.stdout.write(COLOR.reset + "\x1b[K")
  }

  private renderToolFrame(): void {
    const t = this.premium ? getTheme() : null

    const namePart = this.premium
      ? this.c(t!.primary + COLOR.bold, this.activeToolLine.split("  ")[0])
      : this.c(PALETTE.cyan, this.activeToolLine.split("  ")[0])

    const detailPart = this.activeToolLine.split("  ").slice(1).join("  ")

    const detail = detailPart
      ? this.premium
        ? this.c(t!.muted, " · " + detailPart)
        : this.c("dim", "  " + detailPart)
      : ""

    const runningTitle = title("Running")

    const spinnerIdx = Math.floor(this.toolFrame / 1) % THINKING_SPINNER.length

    const loader = this.colors
      ? `${COLOR[THINKING_RAINBOW[spinnerIdx % THINKING_RAINBOW.length]]}${COLOR.bold}${THINKING_SPINNER[spinnerIdx]}${COLOR.reset}`
      : THINKING_SPINNER[spinnerIdx]

    const elapsed = this.toolStartedAt ? Date.now() - this.toolStartedAt : 0

    const elapsedStr = this.c("dim", `${(elapsed / 1000).toFixed(1)}s`)

    const suffix = this.stopHookSuffix ? ` ${this.c("yellow", this.stopHookSuffix)}` : ""

    const line = `\r${loader} ${runningTitle} ${namePart}${detail} ${elapsedStr}${suffix}${COLOR.reset}     \x1b[K`

    process.stdout.write(line)
  }

  toolResult(name: string, text: string, isError: boolean): void {
    this.stopToolSpinner()

    const t = this.premium ? getTheme() : null

    if (this.inToolBlock) {
      if (this.premium) {
        const icon = isError ? this.c(t!.error, "✗") : this.c(t!.success, "✓")

        const namePart = this.c(t!.primary + COLOR.bold, this.activeToolLine.split("  ")[0])

        const detailPart = this.activeToolLine.split("  ").slice(1).join("  ")

        const detail = detailPart ? this.c(t!.muted, " · " + detailPart) : ""

        process.stdout.write(`\r${icon} ${title("Ran")} ${namePart}${detail}\n`)
      } else {
        const color = isError ? PALETTE.failure : PALETTE.success

        process.stdout.write(
          `\r${color}${bullet(isError ? "failure" : "success")} ${title("Ran")} ${this.c(PALETTE.cyan, this.c("bold", this.activeToolLine.split("  ")[0]))}${this.c("dim", "  " + this.activeToolLine.split("  ").slice(1).join("  "))}\x1b[K\n`,
        )
      }

      this.inToolBlock = false
    }

    const lines = text.split("\n")

    this.lastToolResult = { name, text, isError, lines: lines.length }

    this.lastWasRule = false

    const flat = text.replace(/\n/g, " ").trim()

    const preview = flat.slice(0, 200) + (flat.length > 200 ? "…" : "")

    const extra = lines.length > 1 ? this.c("dim", ` (${lines.length} lines)`) : ""

    const ranTitle = title("Ran")

    const toolName =
      this.premium && t ? this.c(t!.primary + COLOR.bold, name) : this.c(PALETTE.cyan, this.c("bold", name))

    if (this.premium && t) {
      const status = isError
        ? `${COLOR.bgBrightRed}${COLOR.white}✗ Error${COLOR.reset}`
        : `${COLOR.bgBrightGreen}${COLOR.black}✔ OK${COLOR.reset}`

      const bodyColor = isError ? t!.error : t!.success

      this.line(
        `  ${status} ${ranTitle} ${toolName} ${this.c(bodyColor, preview)}${extra} ${this.c(t!.muted, "· " + name)}${this.hintSuffix(text)}`,
      )
    } else {
      const marker = bullet(isError ? "failure" : "success")

      const status = isError
        ? `${COLOR.bgBrightRed}${COLOR.white}✗ Error${COLOR.reset}`
        : `${COLOR.bgBrightGreen}${COLOR.black}✔ OK${COLOR.reset}`

      if (!flat) {
        this.line(
          `  ${marker} ${ranTitle} ${toolName} ${status} ${treePrefix("└")} ${this.c("dim", "(no output)")}${this.hintSuffix(text)}`,
        )
      } else if (lines.length > 1) {
        const shown = lines.slice(0, 4)

        for (const l of shown) this.line(`${treePrefix("│")} ${outputLine(l === "" ? " " : l)}`)

        this.line(
          `${treePrefix("└")} ${outputLine(`… +${lines.length - shown.length} lines`)} ${extra}${this.hintSuffix(text)}`,
        )
      } else {
        this.line(`  ${marker} ${ranTitle} ${toolName} ${status}`)

        this.line(`${treePrefix("└")} ${outputLine(preview)}${this.hintSuffix(text)}`)
      }
      this.line("")
    }
  }

  /** Cleanup all timers and active modes. */

  destroy(): void {
    this.stopToolSpinner()

    this.stopStreamingCursor()

    this.exitTranscriptMode()

    this.streamingText = ""

    this.stopHookSuffix = ""

    this.tokenBudget = null

    this.apiMetrics = null

    this.stopLoading()

    this.stopProgress()

    this.cancelAnimationFrames()
  }

  // ─────────────────────────────────────────────────────────────
  // Workflow state handling
  // ─────────────────────────────────────────────────────────────

  public setWorkflowState(
    state: "idle" | "starting" | "running" | "streaming" | "paused" | "error" | "completed" | "failed",
  ): void {
    this.workflowState = state

    this.line(this.workflowStatusLine())
  }

  public getWorkflowState():
    "idle" | "starting" | "running" | "streaming" | "paused" | "error" | "completed" | "failed" {
    return this.workflowState
  }

  public startWorkflow(): void {
    this.setWorkflowState("starting")

    this.setWorkflowState("running")
  }

  public completeWorkflow(): void {
    this.setWorkflowState("completed")
  }

  public failWorkflow(error?: Error | string): void {
    this.setWorkflowState("error")

    this.error(error ?? "Workflow failed")
  }

  public pauseWorkflow(): void {
    this.setWorkflowState("paused")
  }

  public resumeWorkflow(): void {
    this.setWorkflowState("running")
  }

  public workflowStatusLine(): string {
    const state = this.workflowState

    const icon =
      state === "completed"
        ? "✔"
        : state === "failed" || state === "error"
          ? "✖"
          : state === "running" || state === "streaming"
            ? "◉"
            : state === "paused"
              ? "⏸"
              : state === "starting"
                ? "✶"
                : "○"

    const color =
      state === "completed"
        ? "green"
        : state === "failed" || state === "error"
          ? "red"
          : state === "running" || state === "streaming"
            ? "cyan"
            : state === "paused"
              ? "yellow"
              : "dim"

    return `${this.c(color, this.c("bold", `${icon} workflow:`))} ${this.c(color, state)}`
  }

  // ─────────────────────────────────────────────────────────────
  // Animation features
  // ─────────────────────────────────────────────────────────────

  public progressBar(current: number, total: number, width = 40): void {
    if (total <= 0) return

    const pct = Math.max(0, Math.min(1, current / total))

    const filled = Math.floor(width * pct)

    const empty = width - filled

    const bar = this.c("green", "█".repeat(filled)) + this.c("dim", "░".repeat(empty))

    const label = `${this.c("bold", `${Math.round(pct * 100)}%`)} ${current}/${total}`

    process.stdout.write(`\r${bar} ${label}${this.c("reset", " ".repeat(Math.max(0, width - label.length)))}\x1b[K`)

    if (current >= total) process.stdout.write("\n")
  }

  public stopProgress(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer)

      this.progressTimer = null
    }
  }

  public loading(text: string, options?: { color?: keyof typeof COLOR }): () => void {
    if (!this.colors || !process.stdout.isTTY) {
      this.line(text)

      return () => {}
    }

    const color = options?.color ?? "cyan"

    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

    let frame = 0

    const tick = () => {
      process.stdout.write(`\r${this.c(color, frames[frame % frames.length])} ${text}\x1b[K`)

      frame++
    }

    tick()

    this.loadingTimer = setInterval(tick, 100)

    return () => this.stopLoading()
  }

  public stopLoading(): void {
    if (this.loadingTimer) {
      clearInterval(this.loadingTimer)

      this.loadingTimer = null
    }

    process.stdout.write(`\r${" ".repeat(80)}\r`)
  }

  public animateFrame(frameFn: () => void, intervalMs = 100, durationMs = 2000): () => void {
    const start = Date.now()

    const tick = () => {
      frameFn()

      if (Date.now() - start >= durationMs) {
        this.cancelAnimationFrames()
      }
    }

    const id = setInterval(tick, intervalMs)

    this.animationFrames.push(() => clearInterval(id))

    return () => this.cancelAnimationFrames()
  }

  public cancelAnimationFrames(): void {
    for (const cleanup of this.animationFrames) cleanup()

    this.animationFrames = []
  }

  // ─────────────────────────────────────────────────────────────
  // Error handling UI
  // ─────────────────────────────────────────────────────────────

  public error(error: Error | string): void {
    const msg = error instanceof Error ? error.message : String(error)

    this.line(this.c("red", this.c("bold", `✖ ${msg}`)))

    if (error instanceof Error && error.stack) {
      for (const line of error.stack.split("\n").slice(1).slice(0, 5)) {
        this.line(this.c("dim", `  ${line.trim()}`))
      }
    }
  }

  public warn(message: string): void {
    this.line(this.c("yellow", `⚠ ${message}`))
  }

  public success(message: string): void {
    this.line(this.c("green", `✔ ${message}`))
  }

  public errorBox(error: Error | string, options?: { width?: number; retry?: boolean }): void {
    const msg = error instanceof Error ? error.message : String(error)

    const stack = error instanceof Error && error.stack ? error.stack.split("\n").slice(1).join("\n") : ""

    const width = options?.width ?? Math.min(80, Math.max(msg.length + 4, 40))

    const border = this.c("red", "─".repeat(width))

    const padded = msg.length > width - 2 ? msg.slice(0, width - 5) + "..." : msg

    this.line(this.c("red", "┌" + border + "┐"))

    this.line(`${this.c("red", "│")} ${this.c("red", this.c("bold", padded))}${this.c("red", " " + "│")}`)

    if (stack) {
      for (const line of stack.split("\n").slice(0, 3)) {
        const trimmed = line.trim().slice(0, width - 4)

        this.line(`${this.c("red", "│")} ${this.c("dim", trimmed)}${this.c("red", " " + "│")}`)
      }
    }

    if (options?.retry) {
      this.line(`${this.c("red", "│")} ${this.c("dim", "[r] retry · [c] cancel")}${this.c("red", " " + "│")}`)
    }

    this.line(this.c("red", "└" + border + "┘"))
  }

  public async showError(error: Error | string, options?: { retry?: boolean }): Promise<boolean> {
    this.errorBox(error, { retry: options?.retry })

    if (options?.retry) {
      const answer = await this.pickMenu("Retry?", "", [
        { value: "retry", description: "Retry" },
        { value: "cancel", description: "Cancel" },
      ])

      return answer === "retry"
    }

    return true
  }

  /** Dim ctrl+o hint appended when a tool result was truncated for display. */

  private hintSuffix(text: string): string {
    const lines = text.split("\n").length

    if (lines <= 1 && text.length <= 160) return ""

    return this.colors ? ` ${COLOR.cyan}${COLOR.italic}[ctrl+o expand]${COLOR.reset}` : " [ctrl+o expand]"
  }

  /** Print the full output of the most recent tool result (ctrl+o / /expand). */

  expandLastToolResult(): void {
    const last = this.lastToolResult

    if (!last) {
      this.notice("No tool result yet - nothing to expand.")

      return
    }

    const maxLines = 300

    const lines = last.text.split("\n")

    const shown = lines.slice(0, maxLines)

    this.separator()

    this.line(
      this.c("cyan", this.c("bold", ` \u2195 ${last.name}`)) +
        this.c("dim", ` \u00b7 full result \u00b7 ${lines.length} line${lines.length === 1 ? "" : "s"}`),
    )

    for (const l of shown) this.line(" " + l)

    if (lines.length > maxLines) {
      this.line(this.c("dim", ` ... ${lines.length - maxLines} more lines`))
    }

    this.separator()
  }

  /** Trayambak-style split logo: muted left + bold right with shadow gap. */

  splitLogo(art: string): void {
    for (const line of renderSplitLogo(art).split("\n")) this.line(line)
  }

  /** Startup loading screen — logo + braille spinner + status text. */

  startupLoading(logo: string, status: string, frame: number): void {
    this.line(renderStartupLoading(logo, status, frame))
  }

  /** Bottom status bar — model | session | context% | cwd. */

  statusBar(model: string, session: string, contextPct: number, cwd: string): void {
    this.line(renderStatusBar({ model, session, cwd, contextPercent: contextPct }))
  }

  /** File change summary — file +12 -3. */

  fileChange(file: string, added: number, removed: number): void {
    this.line(renderFileChange(file, added, removed))
  }

  /** Status dialog — MCP/LSP/formatters/plugins with colored dots. */

  statusDialog(opts: Parameters<typeof renderStatusDialog>[0]): void {
    this.line(renderStatusDialog(opts))
  }

  private rainbow(text: string): string {
    if (!this.colors) return text

    let out = ""

    for (let i = 0; i < text.length; i++) {
      const key = RAINBOW_BG[i % RAINBOW_BG.length]

      out += this.c(key, text[i])
    }

    return out + COLOR.reset
  }

  notice(text: string): void {
    this.line(this.c("dim", text))
  }

  /** Transient toast notification with optional auto-dismiss. */
  toast(text: string, options?: { holdMs?: number; color?: string }): void {
    const holdMs = options?.holdMs ?? 3000
    const color = options?.color ?? "cyan"
    const prev = this.footerText
    this.line(this.c(color, this.c("bold", text)))
    void setTimeout(() => {
      if (this.footerText === prev) {
        this.footerText = ""
      }
    }, holdMs)
  }

  /**
   * Present an interactive permission prompt to the user.
   * Returns the selected option or null if cancelled.
   */
  async requestPermission(tool: string, reason?: string): Promise<"allow" | "allow-always" | "deny" | null> {
    const options = [
      { value: "allow", description: "Allow once" },
      { value: "allow-always", description: "Allow for this session" },
      { value: "deny", description: "Deny" },
    ]
    const body = reason ? "  " + this.c("dim", reason) : ""
    const picked = await this.pickMenu("Permission required: " + this.c("bold", tool), body, options)
    return picked as "allow" | "allow-always" | "deny" | null
  }

  /** Persistent one-line footer above the prompt. */

  footer(opts: {
    model: string
    cwd: string
    session?: string
    build?: "pass" | "fail" | "skip" | "running"
    contextPercent?: number
    streaming?: boolean
  }): void {
    const t = this.premium ? getTheme() : null

    const cols = process.stdout.columns || 100

    const segs: string[] = []

    if (this.premium && t) {
      segs.push(`${COLOR.bgBlue}${COLOR.white}${COLOR.bold} TRAYAMBAK ${COLOR.reset}`)

      segs.push(`${t.muted}model:${COLOR.reset} ${t.secondary}${opts.model}${COLOR.reset}`)

      if (opts.session) segs.push(`${t.muted}session:${COLOR.reset} ${t.accent}${opts.session}${COLOR.reset}`)

      if (opts.contextPercent !== undefined) {
        const color = opts.contextPercent > 80 ? t.error : t.success

        segs.push(`${t.muted}ctx:${COLOR.reset} ${color}${opts.contextPercent}%${COLOR.reset}`)
      }

      if (opts.build) {
        const c = opts.build === "pass" ? t.success : opts.build === "fail" ? t.error : t.muted

        segs.push(`${t.muted}build:${COLOR.reset} ${c}${opts.build}${COLOR.reset}`)
      }

      if (opts.streaming) segs.push(`${t.accent}● streaming${COLOR.reset}`)

      const left = segs.join(" ")

      const cwd = `${t.muted}${opts.cwd}${COLOR.reset}`

      const used = stripAnsi(left).length

      const pad = Math.max(1, cols - used - stripAnsi(cwd).length - 1)

      this.line(left + " ".repeat(pad) + cwd)
    } else {
      segs.push(`${COLOR.bgBlue}${COLOR.white}${COLOR.bold} TRAYAMBAK ${COLOR.reset}`)

      segs.push(`${this.c("dim", "model:")} ${this.c("cyan", opts.model)}`)

      if (opts.session) segs.push(`${this.c("dim", "session:")} ${this.c("magenta", opts.session)}`)

      if (opts.contextPercent !== undefined) {
        const color = opts.contextPercent > 80 ? "red" : "green"

        segs.push(`${this.c("dim", "ctx:")} ${this.c(color, String(opts.contextPercent) + "%")}`)
      }

      if (opts.build) {
        const c = opts.build === "pass" ? "green" : opts.build === "fail" ? "red" : "dim"

        segs.push(`${this.c("dim", "build:")} ${this.c(c, opts.build)}`)
      }

      if (opts.streaming) segs.push(`${this.c("magenta", "● streaming")}`)

      const left = segs.join(" ")

      const cwd = this.c("dim", opts.cwd)

      const used = stripAnsi(left).length

      const pad = Math.max(1, cols - used - stripAnsi(cwd).length - 1)

      this.line(left + " ".repeat(pad) + cwd)
    }
  }

  /** Light-cyan italic rule line used to frame every output block.

   *  Guards against stacking two rules back-to-back. */

  separator(): void {
    if (this.lastWasRule) return

    this.lastWasRule = true

    const t = getTheme()

    const rule = this.premium ? "\u2501".repeat(process.stdout.columns || 100) : "=".repeat(88)

    const out = this.colors
      ? `${this.premium ? t.primary + COLOR.dim : COLOR.italic + COLOR.cyan}${rule}${COLOR.reset}`
      : rule

    process.stdout.write(out + "\n")
  }

  async prompt(
    _question: string,
    options?: {
      onKeypress?: (action: string) => void

      voiceEnabled?: boolean

      captureVoice?: () => Promise<string>

      slashCommands?: Array<{
        label: string
        description: string
        key?: string
        chooser?: Array<{ value: string; description: string }>
      }>

      developerMode?: boolean
    },
  ): Promise<string> {
    return new Promise((resolve) => {
      const devMode = options?.developerMode ?? this.premium

      const promptColor = devMode ? "magenta" : "green"

      const promptGlyph = devMode ? "❯" : "›"

      const promptText = this.c(promptColor, promptGlyph + " ")

      process.stdout.write("\r\x1b[2K" + promptText)

      process.stdout.write("\x1b[?25l")

      process.stdin.setRawMode?.(/*mode*/ true)
      process.stdin.resume?.()

      let buffer = ""

      let frame = 0

      let slashActive = 0

      let slashOpen = false

      let slashRendered = 0

      let boxLinesRendered = 0

      const slashCommands = options?.slashCommands ?? []

      const onKeypress = options?.onKeypress

      const voiceEnabled = options?.voiceEnabled

      const filteredSlash = (): Array<{
        label: string
        description: string
        key?: string
        chooser?: Array<{ value: string; description: string }>
      }> => {
        if (buffer.startsWith("/")) {
          const rest = buffer.slice(1)

          if (rest.includes(" ")) {
            const cmd = rest.split(" ")[0]

            const q = rest.slice(cmd.length + 1)

            const match = slashCommands.find((c) => c.label === "/" + cmd)

            if (match && match.chooser) {
              const lower = q.toLowerCase()

              if (!q) return [{ label: "/" + cmd + " ", description: "choose a value (" + match.chooser.length + ")" }]

              return match.chooser

                .filter((c) => c.value.toLowerCase().includes(lower))

                .map((c) => ({ label: "/" + cmd + " " + c.value, description: c.description, key: "" }))
            }

            return []
          }

          if (!rest) return slashCommands

          const lower = rest.toLowerCase()

          return slashCommands.filter(
            (c) => c.label.toLowerCase().includes(lower) || c.label.toLowerCase().includes("/" + lower),
          )
        }

        return []
      }

      // Bottom-anchored erase: the slash menu occupies `slashRendered` rows
      // BELOW the composer, and the cursor currently sits on the LAST menu
      // row. Move up exactly `slashRendered` rows (onto the composer row),
      // clear the composer row, then clear the menu rows below it one by one.
      // Finally move back up `slashRendered` rows so the cursor rests on the
      // composer row. Only single-row `\x1b[B` moves are used after the
      // initial jump, so the anchor cannot drift on Windows ConPTY.
      const eraseMenu = (): void => {
        if (slashRendered > 0) {
          const rows = Math.min(slashRendered, 40)

          for (let i = 0; i < rows; i++) {
            process.stdout.write(`\x1b[1A\r\x1b[2K`)
          }

          slashRendered = 0
        }
      }

      const clearSlash = (): void => {
        eraseMenu()

        slashOpen = false

        slashRendered = 0

        process.stdout.write("\r\x1b[K")
      }

      const eraseBox = (): void => {
        if (boxLinesRendered > 0) {
          process.stdout.write(`\r\x1b[2K`)
          for (let i = 1; i < boxLinesRendered; i++) {
            process.stdout.write(`\x1b[1A\r\x1b[2K`)
          }
          boxLinesRendered = 0
        }
      }

      const isChooserMode = (): boolean => {
        if (!buffer.startsWith("/")) return false

        const rest = buffer.slice(1)

        if (!rest.includes(" ")) return false

        const cmd = rest.split(" ")[0]

        const match = slashCommands.find((c) => c.label === "/" + cmd)

        return !!(match && match.chooser)
      }

      const renderType = (): void => {
        const glyph = devMode ? "\u25c6" : TYPE_FRAMES[frame % TYPE_FRAMES.length]

        const bufColor: keyof typeof COLOR = buffer.startsWith("/") ? "white" : devMode ? "magenta" : "cyan"

        const matches = buffer.startsWith("/") && slashCommands.length > 0 ? filteredSlash() : []

        const wantsMenu = buffer.startsWith("/") && slashCommands.length > 0 && matches.length > 0

        const vm = this.colors ? (devMode ? "\x1b[38;5;213m" : "\x1b[38;5;117m") : ""

        const muted = this.colors ? "\x1b[38;5;245m" : ""

        const reset = this.colors ? "\x1b[0m" : ""

        const block: string[] = []

        if (wantsMenu) {
          const headerLabel = isChooserMode() ? "choose a value" : "commands"

          block.push(`${vm}  \u250c\u2500 ${headerLabel} (${matches.length})${reset}`)

          const maxVisible = Math.min(matches.length, 8)

          let scrollTop = 0

          if (slashActive >= scrollTop + maxVisible) {
            scrollTop = slashActive - maxVisible + 1
          } else if (slashActive < scrollTop) {
            scrollTop = slashActive
          }

          const top = matches.slice(scrollTop, scrollTop + maxVisible)

          for (let i = 0; i < top.length; i++) {
            const m = top[i]

            const realIndex = scrollTop + i

            const isActive = realIndex === slashActive

            const mark = isActive ? `${vm}\u203a${reset}` : " "

            const labelText = isChooserMode() && m.label.includes(" ") ? m.label.split(" ").slice(1).join(" ") : m.label

            const label = isActive ? `\x1b[1m${labelText}\x1b[0m` : `${muted}${labelText}${reset}`

            const desc = `${muted}${m.description}${reset}`

            block.push(`${mark} ${label}  ${desc}`)
          }

          if (matches.length > maxVisible) {
            block.push(`${muted}  \u2026 ${scrollTop + 1}-${scrollTop + top.length} / ${matches.length}${reset}`)
          }

          slashActive = Math.min(slashActive, matches.length - 1)

          slashOpen = true
        } else {
          slashOpen = false
        }

        const cols = process.stdout.columns ?? 80
        const boxW = Math.max(30, Math.min(84, cols - 2))

        if (wantsMenu) {
          eraseBox()
          eraseMenu()
          process.stdout.write(block.join("\n"))
          process.stdout.write("\r\x1b[K")
          process.stdout.write(`${promptText}${this.c(bufColor, buffer)}${this.c("cyan", glyph)}\x1b[K`)
          slashRendered = block.length
          boxLinesRendered = 0
        } else {
          eraseMenu()
          eraseBox()
          const modeTag = devMode ? " (DEV)" : ""
          const header = `╭─ Trayambak Input${modeTag} ` + "─".repeat(Math.max(2, boxW - 20 - modeTag.length)) + "╮"
          const footer =
            `╰─ ` +
            this.c("dim", "[Enter] Submit  [Ctrl+C] Exit  [↑/↓] History  [/] Commands") +
            " " +
            "─".repeat(Math.max(2, boxW - 62)) +
            "╯"

          const maxBufW = boxW - 6
          const displayBuf = buffer.length > maxBufW ? "…" + buffer.slice(buffer.length - maxBufW + 1) : buffer
          const visibleLen = stripAnsi(displayBuf).length
          const padLen = Math.max(0, boxW - 4 - visibleLen - 2)
          const mid = `│ ${promptText}${this.c(bufColor, displayBuf)}${this.c("cyan", glyph)}${" ".repeat(padLen)} │`

          process.stdout.write(`${this.c(bufColor, header)}\n${mid}\n${this.c("dim", footer)}`)
          boxLinesRendered = 3
          slashRendered = 0
        }
      }

      const stopSpinner = (): void => {
        if (this.typeTimer) {
          clearInterval(this.typeTimer)

          this.typeTimer = null
        }
      }

      const stopPromptAnim = (): void => {
        if (this.promptAnimTimer) {
          clearInterval(this.promptAnimTimer)

          this.promptAnimTimer = null
        }
      }

      // ── Bracketed paste support (Windows Terminal sends \x1b[200~...\x1b[201~ on Ctrl+V) ──

      let pasteBuf: string | null = null

      const insertPaste = (text: string): void => {
        const cleaned = text.replace(/\r\n?/g, "\n").replace(/\n+/g, " ").trim()

        if (cleaned) {
          buffer += cleaned

          slashActive = 0

          if (onKeypress) {
            onKeypress("paste")
          }
        }

        renderType()
      }

      const finish = (val: string): void => {
        stopSpinner()

        stopPromptAnim()

        clearSlash()
        eraseBox()

        process.stdout.write("\r\x1b[K")

        stdin.setRawMode?.(/*mode*/ false)

        process.stdout.write("\x1b[?25h\x1b[?2004l")

        stdin.removeListener("data", handleKey)

        stdin.pause()

        resolve(val)
      }

      const handleKey = async (chunk: Buffer): Promise<void> => {
        let s = chunk.toString("utf8")

        // \u2500\u2500 Bracketed paste continuation: \x1b[200~ ... \x1b[201~ may span chunks \u2500\u2500

        if (pasteBuf !== null) {
          const end = s.indexOf("\x1b[201~")

          if (end === -1) {
            pasteBuf += s
            return
          }

          pasteBuf += s.slice(0, end)

          s = s.slice(end + 6)

          insertPaste(pasteBuf)

          pasteBuf = null

          if (s.length === 0) return
        }

        for (let i = 0; i < s.length; i++) {
          const code = s.charCodeAt(i)

          // Ctrl shortcuts (0x01 - 0x1A)

          if (voiceEnabled && code === 17) {
            if (options?.captureVoice) {
              options.captureVoice().then((text) => {
                if (text) finish(text)
              })
            }

            continue
          }

          if (code === 3) {
            if (onKeypress) {
              onKeypress("stop_generation")
            }

            clearSlash()

            process.stdout.write("\r\x1b[2K")

            stdin.setRawMode?.(/*mode*/ false)

            process.stdout.write("\x1b[?25h")

            stdin.removeListener("data", handleKey)

            stdin.pause()

            process.exit(0)
          }

          if (code === 4) {
            if (onKeypress) {
              onKeypress("exit")
            }

            clearSlash()

            process.stdout.write("\r\x1b[2K")

            stdin.setRawMode?.(/*mode*/ false)

            process.stdout.write("\x1b[?25h")

            stdin.removeListener("data", handleKey)

            stdin.pause()

            process.exit(0)
          }

          if (code === 1) {
            onKeypress?.("approve")
            continue
          }

          if (code === 24) {
            onKeypress?.("deny")
            continue
          }

          if (code === 14) {
            onKeypress?.("toggleNotifications")
            this.toggleNotifications()
            renderType()
            continue
          }

          if (code === 26) {
            onKeypress?.("undo")
            continue
          }

          if (code === 16 || code === 25) {
            onKeypress?.("togglePermission")
            await this.togglePermissionMode()
            renderType()
            continue
          }
          if (code === 18) {
            onKeypress?.("redo")
            continue
          }

          if (code === 8) {
            onKeypress?.("help")
            renderType()
            continue
          }

          if (code === 15) {
            if (onKeypress) {
              onKeypress("menu")
              renderType()
              continue
            }

            process.stdout.write("\n")

            this.expandLastToolResult()

            renderType()

            continue
          }

          if (code === 12) {
            onKeypress?.("clear")
            continue
          }

          if (code === 22) {
            const clip = readClipboardText()

            if (clip) {
              buffer += clip.replace(/\r\n?/g, "\n").replace(/\n+/g, " ").trim()

              slashActive = 0

              if (onKeypress) {
                onKeypress("paste")
              }
            }

            renderType()

            continue
          }

          if (code === 16) {
            onKeypress?.("points")
            renderType()
            continue
          }

          if (code === 63) {
            onKeypress?.("help")
            renderType()
            continue
          }

          // \u2500\u2500 Bracketed paste start: ESC [ 2 0 0 ~ \u2500\u2500

          if (code === 27 && s.startsWith("\x1b[200~", i)) {
            const end = s.indexOf("\x1b[201~", i + 6)

            if (end === -1) {
              pasteBuf = s.slice(i + 6) // wait for remaining chunks

              return
            }

            insertPaste(s.slice(i + 6, end))

            i = end + 5 // loop i++ lands past \x1b[201~

            continue
          }

          // \u2500\u2500 Arrow keys: ESC [ A (up) / ESC [ B (down) / ESC [ C (right) / ESC [ D (left) \u2500\u2500

          if (code === 27 && i + 2 < s.length && s.charCodeAt(i + 1) === 91) {
            const arrow = s.charCodeAt(i + 2)

            if (arrow === 65) {
              // Up arrow

              if (slashOpen) {
                const matches = filteredSlash()

                if (matches.length > 0) {
                  slashActive = slashActive <= 0 ? matches.length - 1 : slashActive - 1

                  renderType()
                }
              }

              i += 2 // skip [ and A

              continue
            }

            if (arrow === 66) {
              // Down arrow

              if (slashOpen) {
                const matches = filteredSlash()

                if (matches.length > 0) {
                  slashActive = slashActive >= matches.length - 1 ? 0 : slashActive + 1

                  renderType()
                }
              }

              i += 2 // skip [ and B

              continue
            }

            // Right (67) / Left (68) \u2014 consume but ignore

            if (arrow === 67 || arrow === 68) {
              i += 2

              continue
            }

            // Other ESC [ sequences \u2014 fall through, let ESC be handled below
          }

          // Truncated CSI sequence at chunk boundary \u2014 wait for the rest

          const rest = s.slice(i)

          if (
            code === 27 &&
            ["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", "\x1b[200~", "\x1b[201~"].some(
              (q) => q.startsWith(rest) && q.length > rest.length,
            )
          ) {
            return
          }

          // ESC alone \u2014 close slash menu

          if (code === 27) {
            if (slashOpen) {
              clearSlash()

              slashActive = 0

              renderType()
            }

            continue
          }

          if (code === 13) {
            if (slashOpen) {
              const matches = filteredSlash()

              const m = matches[slashActive]

              if (m) {
                clearSlash()
                finish(m.label)
                return
              }
            }

            finish(buffer)

            return
          }

          if (code === 127 || code === 8) {
            buffer = buffer.slice(0, -1)

            slashActive = 0
          } else if (code >= 32 && code !== 127) {
            // printable ASCII + all unicode (Hindi, emoji, etc.)

            buffer += s[i]

            slashActive = 0
          }

          frame++

          renderType()
        }
      }

      const stdin = process.stdin

      stdin.setRawMode?.(/*mode*/ true)

      stdin.resume()

      stdin.setEncoding("utf8")

      process.stdout.write("\x1b[?2004h") // enable bracketed paste mode

      stdin.on("data", handleKey)

      renderType()

      this.promptAnimTimer = setInterval(() => {
        frame++

        renderType()
      }, 80)
    })
  }

  /** Overlay approval dialog: title + body + choices, ↑/↓ + enter, esc cancels.

   *  Returns the chosen value, or null when cancelled. */

  async askApproval(
    title: string,
    body: string,
    choices: Array<{ label: string; value: string }>,
  ): Promise<string | null> {
    return this.pickMenu(
      title,
      body,
      choices.map((c) => ({ value: c.value, description: c.label })),
    )
  }

  /** Option chooser overlay: question + options, ↑/↓ + enter, esc cancels.

   *  Returns the chosen value, or null when cancelled. */

  handlePermissionEvent(event: { id: string; tool: string; args: unknown; reason: string }): void {
    if (event.tool === "trayambak__AskUserQuestion") {
      return
    }

    const width = Math.max(40, Math.min((process.stdout.columns ?? 100) - 4, 88))

    this.line("")

    const headColor = this.colors ? (this.premium ? "\x1b[38;5;213m" : "\x1b[38;5;117m") : ""

    const muted = this.colors ? "\x1b[38;5;245m" : ""

    const reset = this.colors ? "\x1b[0m" : ""

    this.line(`${headColor}  ┌─ Approval required${reset}`)

    this.line(`${muted}  │ tool: ${event.tool}${reset}`)

    this.line(`${muted}  │ reason: ${event.reason.slice(0, width - 14)}${reset}`)

    const argsStr = typeof event.args === "string" ? event.args : JSON.stringify(event.args)

    for (const bl of argsStr.split("\n").slice(0, 6)) {
      this.line(`${muted}  │ ${bl.slice(0, width - 6)}${reset}`)
    }

    this.line(`${muted}  │ mode: ${this.permissionMode}${reset}`)

    this.line(`${muted}  └─ y approve · a session · d don't ask again · x deny${reset}`)

    try {
      notifyForEvent(
        {
          type: "permission_request",
          id: event.id,
          tool: event.tool,
          args: event.args,
          reason: event.reason,
        } as AgentEvent,
        DEFAULT_NOTIFICATION_CONFIG,
      )
    } catch {}

    try {
      this.notify("Approval", event.tool + " \u2014 " + event.reason)
    } catch {}
  }

  toggleNotifications(): void {
    this.line(this.c("dim", "Notifications toggled (Ctrl+N)"))
  }

  async togglePermissionMode(): Promise<void> {
    this.separator()

    const order: Array<"read-only" | "ask" | "auto-approve" | "full-access"> = [
      "read-only",
      "ask",
      "auto-approve",
      "full-access",
    ]
    const idx = order.indexOf(this.permissionMode)
    this.permissionMode = order[(idx + 1) % order.length]

    const isYolo = this.permissionMode === "full-access" || this.permissionMode === "auto-approve"
    const isRO = this.permissionMode === "read-only"

    try {
      const { globalApprovalManager } = await import("./approval-notification.js")
      globalApprovalManager.setAutoApprove(isYolo)
      globalApprovalManager.setReadOnly(isRO)
    } catch {}

    const labels: Record<string, string> = {
      "read-only": this.c("cyan", this.c("bold", "\uD83D\uDD12 READ-ONLY \u2014 no writes")),
      ask: this.c("green", this.c("bold", "\uD83D\uDD12 ASK \u2014 approval required")),
      "auto-approve": this.c("yellow", this.c("bold", "\u26a1 AUTO-APPROVE \u2014 writes allowed")),
      "full-access": this.c("red", this.c("bold", "\u26a1 FULL ACCESS \u2014 danger, no approvals")),
    }
    const badge = labels[this.permissionMode] ?? labels["ask"]

    this.line(badge)

    this.line(this.c("dim", "  Ctrl+P to toggle \u00b7 read-only \u2192 ask \u2192 auto-approve \u2192 full-access"))

    try {
      this.notify(
        "Permission",
        `${this.permissionMode.toUpperCase()} \u2014 ${isYolo ? "auto-approved" : "approval required"}`,
      )
    } catch {}
    try {
      const { globalNotificationDispatcher } = await import("./approval-notification.js")
      globalNotificationDispatcher.info("Permissions", `Mode set to ${this.permissionMode}`)
    } catch {}

    try {
      const cfgPath = path.join(os.homedir(), ".trayambak", "config.json")

      let cfg: Record<string, unknown> = {}

      try {
        cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"))
      } catch {}

      cfg.permissions = { mode: this.permissionMode, askByDefault: !isYolo }

      fs.mkdirSync(path.dirname(cfgPath), { recursive: true })

      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
    } catch {}
  }

  getPermissionMode(): string {
    return this.permissionMode
  }
  getPermissionModes() {
    return ["read-only", "ask", "auto-approve", "full-access"] as const
  }

  async setPermissionMode(mode: "read-only" | "ask" | "auto-approve" | "full-access"): Promise<void> {
    this.permissionMode = mode
    try {
      const { globalApprovalManager } = await import("./approval-notification.js")
      globalApprovalManager.setAutoApprove(mode === "auto-approve" || mode === "full-access")
      globalApprovalManager.setReadOnly(mode === "read-only")
    } catch {}
  }

  isYolo(): boolean {
    return this.permissionMode === "full-access" || this.permissionMode === "auto-approve"
  }
  isReadOnly(): boolean {
    return this.permissionMode === "read-only"
  }

  notify(title: string, body: string): void {
    try {
      notifyForEvent(
        { type: "permission_request", id: "manual", tool: title, args: body, reason: body } as AgentEvent,
        DEFAULT_NOTIFICATION_CONFIG,
      )
    } catch {}

    this.line(this.c("cyan", title + ": " + body))
  }

  async chooseOption(
    question: string,
    options: Array<{ value: string; description?: string }>,
  ): Promise<string | null> {
    return this.pickMenu(question, "", options)
  }

  /** Shared selectable menu renderer used by askApproval/chooseOption. */

  private hotkeyOf(value: string): string {
    if (value === "approve") return "y"
    if (value === "approve_session") return "a"
    if (value === "dont_ask_again") return "d"
    if (value === "deny") return "x"
    return ""
  }

  /** Shared selectable menu renderer used by askApproval/chooseOption. */
  private async pickMenu(
    title: string,
    body: string,
    options: Array<{ value: string; description?: string }>,
  ): Promise<string | null> {
    if (options.length === 0) return null

    return new Promise((resolve) => {
      const stdin = process.stdin

      let active = 0

      let done = false

      // Visible window into the option list — a chooser can hold far more
      // entries than the terminal can show (e.g. /resume lists 20 sessions),
      // so scroll it instead of overflowing the screen.

      const maxVisible = 10

      let scrollTop = 0

      const syncScroll = (): void => {
        if (active < scrollTop) scrollTop = active

        if (active >= scrollTop + maxVisible) scrollTop = active - maxVisible + 1

        scrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, options.length - maxVisible)))
      }

      let rendered = 0

      const drainStdin = (): void => {
        const onData = (): void => {}

        stdin.on("data", onData)

        setTimeout(() => {
          stdin.removeListener("data", onData)
        }, 50)
      }

      drainStdin()

      const render = (): void => {
        const cols = process.stdout.columns || 100

        const headColor = this.colors ? "\x1b[38;5;117m" : ""

        const muted = this.colors ? "\x1b[38;5;245m" : ""

        const reset = this.colors ? "\x1b[0m" : ""

        const width = Math.max(30, Math.min(cols - 4, 84))

        const lines: string[] = []

        lines.push("")

        lines.push(`${headColor}  ┌─ ${title}${reset}`)

        if (body) {
          for (const bl of body.split("\n").slice(0, 12)) {
            lines.push(`${muted}  │ ${bl.slice(0, width - 6)}${reset}`)
          }
        }

        for (let i = scrollTop; i < scrollTop + maxVisible && i < options.length; i++) {
          const o = options[i]

          const isActive = i === active

          const mark = isActive ? `${headColor}❯${reset}` : " "

          const hk = this.hotkeyOf(o.value)
          const badge = hk ? `${headColor}[${hk}]${reset} ` : ""
          const label = isActive ? `\x1b[1m${o.value}\x1b[0m` : o.value

          const desc = o.description
            ? `  ${muted}${o.description.slice(0, Math.max(0, width - o.value.length - 10))}${reset}`
            : ""

          lines.push(`${mark} ${badge}${label}${desc}`)
        }

        const hasOverflow = options.length > maxVisible

        if (hasOverflow) {
          const after = options.length - scrollTop - maxVisible

          const before = scrollTop

          lines.push(`${muted}  └─ [↑${before} ↓${after}] · ↑/↓ choose · enter select · esc cancel${reset}`)
        } else {
          lines.push(`${muted}  └─ ↑/↓ choose · enter select · esc cancel${reset}`)
        }

        process.stdout.write(lines.join("\n"))

        rendered = lines.length
      }

      const clear = (): void => {
        if (rendered > 0) {
          const rows = Math.min(rendered, 40)

          process.stdout.write(`\x1b[${rows}A`)

          for (let i = 0; i < rows; i++) {
            process.stdout.write(`\r\x1b[K${i < rows - 1 ? "\x1b[B" : ""}`)
          }

          process.stdout.write("\x1b[B")

          rendered = 0
        }
      }

      const finish = (val: string | null): void => {
        if (done) return

        done = true

        clear()

        stdin.setRawMode?.(/*mode*/ false)

        process.stdout.write("\x1b[?25h\x1b[?2004h")

        stdin.removeListener("data", handle)

        stdin.pause?.()

        resolve(val)
      }

      const handle = async (chunk: string): Promise<void> => {
        const s = String(chunk)

        for (let i = 0; i < s.length; i++) {
          const code = s.charCodeAt(i)

          // ── Bracketed paste: ESC [ 2 0 0 ~ ... ESC [ 2 0 1 ~ ──
          // A chooser has no text input, so a paste cannot be inserted.
          // Consume the whole sequence silently instead of letting the
          // leading ESC trigger the "esc cancels" path, which would abort
          // the menu and drop the pasted content.

          if (code === 27 && s.startsWith("\x1b[200~", i)) {
            const end = s.indexOf("\x1b[201~", i + 6)

            if (end === -1) {
              return
            } // wait for the rest of the paste

            i = end + 5 // loop i++ lands past \x1b[201~

            continue
          }

          if (code === 27 && i + 2 < s.length && s.charCodeAt(i + 1) === 91) {
            const arrow = s.charCodeAt(i + 2)

            if (arrow === 65) {
              active = active <= 0 ? options.length - 1 : active - 1
              syncScroll()
              clear()
              render()
              i += 2
              continue
            }

            if (arrow === 66) {
              active = active >= options.length - 1 ? 0 : active + 1
              syncScroll()
              clear()
              render()
              i += 2
              continue
            }

            if (arrow === 67 || arrow === 68) {
              i += 2
              continue
            }
          }

          if (code === 1) {
            const hit = options.find((o) => o.value === "approve")
            if (hit) {
              finish(hit.value)
              return
            }
            if (options.length > 0) {
              finish(options[active]?.value ?? null)
              return
            }
          }

          if (code === 24) {
            const hit = options.find((o) => o.value === "deny")
            if (hit) {
              finish(hit.value)
              return
            }
            finish(null)
            return
          }

          if (code === 14) {
            this.toggleNotifications()
            clear()
            render()
            continue
          }
          if (code === 16 || code === 25) {
            await this.togglePermissionMode()
            clear()
            render()
            continue
          }

          if (code === 27) {
            finish(null)
            return
          }

          // Approval hotkeys: y=approve, a=session, d=don't ask again, x/n=deny
          const keyChar = String.fromCharCode(code).toLowerCase()
          const hotkeyToValue: Record<string, string> = {
            y: "approve",
            a: "approve_session",
            d: "dont_ask_again",
            x: "deny",
            n: "deny",
          }
          const hotValue = hotkeyToValue[keyChar]
          if (hotValue) {
            const hit = options.find((o) => o.value === hotValue)
            if (hit) {
              finish(hit.value)
              return
            }
          }

          if (code === 13) {
            finish(options[active]?.value ?? null)
            return
          }

          if (code === 3 || code === 4) {
            finish(null)
            return
          }
        }
      }

      stdin.setRawMode?.(/*mode*/ true)

      stdin.resume()

      stdin.setEncoding("utf8")

      stdin.on("data", handle)

      render()
    })
  }
}

/** Read text from the system clipboard (Windows/macOS/Linux). */

export function readClipboardText(): string {
  try {
    if (process.platform === "win32") {
      return child_process

        .execSync("powershell -NoProfile -Command Get-Clipboard", { encoding: "utf8", timeout: 5_000 })

        .replace(/\r\n/g, "\n")
    }

    if (process.platform === "darwin") {
      return child_process.execSync("pbpaste", { encoding: "utf8", timeout: 5_000 })
    }

    return child_process.execSync("xclip -selection clipboard -o", { encoding: "utf8", timeout: 5_000 })
  } catch {
    return ""
  }
}

/**

 * Shrink an ASCII-art block: keep every `1/scale`-th line and trim each line

 * to ~2/3 of its width so startups do not drown the terminal.

 */

export function scaleAscii(art: string, scale: number): string {
  if (scale >= 1) return art

  const lines = art.split("\n").filter((l) => l.trim().length > 0)

  const step = Math.max(1, Math.round(1 / scale))

  const kept = lines.filter((_, i) => i % step === 0)

  const maxWidth = Math.max(...kept.map((l) => l.length))

  const targetWidth = Math.max(40, Math.floor(maxWidth * 0.66))

  return kept

    .map((l) => l.slice(0, targetWidth).replace(/\s+$/, ""))

    .join("\n")
}

/** Subscribe an AgentEvent stream to a TerminalUI instance. */

export function renderEvent(event: AgentEvent, ui: TerminalUI): void {
  switch (event.type) {
    case "message_update": {
      const delta = event.delta

      if (delta.text) ui.streamAssistantText(delta.text)

      if (delta.thinking) ui.thinking(delta.thinking)

      break
    }
    case "message_end": {
      ui.flushThinking()

      const hadStreamed = ui.hasStreamedText() || ui.hasAssistantStarted()

      ui.finalizeAssistantText()

      if (!hadStreamed) {
        const content: unknown = event.message?.content

        if (Array.isArray(content)) {
          const full = content

            .filter((part): part is TextPart => part.type === "text" && typeof part.text === "string")

            .map((part) => part.text)

            .join("\n")

          if (full) ui.line(full)
        }
      }

      break
    }

    case "tool_call":
      ui.toolCallStructured(event.id, event.name, event.arguments ?? {})

      break

    case "tool_result":
      ui.toolResultStructured(event.id, event.result ?? {})

      break

    case "verification_start":
      ui.separator()

      ui.line(ui.c("bold", "Verification started..."))

      break

    case "verification_step":
      ui.line(ui.c("dim", `  \u2022 ${event.name}: ${event.status}${event.detail ? ` - ${event.detail}` : ""}`))

      break

    case "verification_end":
      ui.line(ui.c(event.passed ? "green" : "red", `Verification ${event.passed ? "passed" : "failed"}`))

      ui.separator()

      break

    case "agent_end":
      ui.line()

      break
  }
}
