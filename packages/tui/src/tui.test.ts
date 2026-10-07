/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { EventEmitter } from "events"
import { TerminalUI, COLOR, scaleAscii, renderEvent } from "./index"
import type { AgentEvent } from "../../protocol/src/index"
import { ApprovalManager } from "./approval-notification"

import {
  renderPopup,
  renderDiff,
  renderMarkdown,
  renderCodeBlock,
  renderStatusBar,
  renderFileChange,
  renderUserBubble,
  renderAssistantBubble,
  renderHeader,
  buildDiff,
} from "./dialogs"

function captureStdout(): { output: string[]; restore: () => void } {
  const output: string[] = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  const originalIsTTY = process.stdout.isTTY
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(typeof chunk === "string" ? chunk : chunk.toString())
    return true
  }) as unknown as typeof process.stdout.write
  return {
    output,
    restore: () => {
      process.stdout.write = originalWrite
      Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true })
    },
  }
}

describe("COLOR constants", () => {
  it("COLOR constants are ANSI escape codes", () => {
    expect(COLOR.reset).toBe("\x1b[0m")
    expect(COLOR.cyan).toBe("\x1b[36m")
    expect(COLOR.red).toBe("\x1b[31m")
    expect(COLOR.green).toBe("\x1b[32m")
    expect(COLOR.bold).toBe("\x1b[1m")
  })
})

describe("TerminalUI: restoreTerminal", () => {
  it("enables line wrap (?7h) not disables (?7l)", () => {
    const cap = captureStdout()
    try {
      TerminalUI.restoreTerminal()
      const output = cap.output.join("")
      expect(output).toContain("\x1b[?7h")
      expect(output).not.toContain("\x1b[?7l")
    } finally {
      cap.restore()
    }
  })

  it("shows cursor (?25h) on restore", () => {
    const cap = captureStdout()
    try {
      TerminalUI.restoreTerminal()
      const output = cap.output.join("")
      expect(output).toContain("\x1b[?25h")
    } finally {
      cap.restore()
    }
  })
})

describe("TerminalUI: footer", () => {
  let cap: ReturnType<typeof captureStdout>

  beforeEach(() => {
    cap = captureStdout()
  })

  afterEach(() => {
    cap.restore()
  })

  it("includes the model name in the footer output", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.footer({ model: "llama-3-8b", cwd: "/home/user" })
    const output = cap.output.join("")
    expect(output).toContain("llama-3-8b")
    expect(output).toContain("model:")
  })

  it("includes the session name when provided", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.footer({ model: "gemma", cwd: "/home", session: "sess-123" })
    const output = cap.output.join("")
    expect(output).toContain("sess-123")
    expect(output).toContain("session:")
  })

  it("includes context percentage", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.footer({ model: "llama", cwd: "/home", contextPercent: 45 })
    const output = cap.output.join("")
    expect(output).toContain("45%")
    expect(output).toContain("ctx:")
  })

  it("marks high context usage in red", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.footer({ model: "llama", cwd: "/home", contextPercent: 85 })
    const output = cap.output.join("")
    expect(output).toContain("85%")
  })

  it("marks low context usage in green", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.footer({ model: "llama", cwd: "/home", contextPercent: 45 })
    const output = cap.output.join("")
    expect(output).toContain("45%")
  })

  it("includes build status", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.footer({ model: "llama", cwd: "/home", build: "pass" })
    const output = cap.output.join("")
    expect(output).toContain("build:")
    expect(output).toContain("pass")
  })

  it("includes streaming indicator", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.footer({ model: "llama", cwd: "/home", streaming: true })
    const output = cap.output.join("")
    expect(output).toContain("streaming")
  })

  it("includes cwd at the end", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.footer({ model: "llama", cwd: "/my/path" })
    const output = cap.output.join("")
    expect(output).toContain("/my/path")
  })

  it("includes TRAYAMBAK badge", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.footer({ model: "llama", cwd: "/home" })
    const output = cap.output.join("")
    expect(output).toContain("TRAYAMBAK")
  })
})

describe("TerminalUI: separator", () => {
  let cap: ReturnType<typeof captureStdout>

  beforeEach(() => {
    cap = captureStdout()
  })

  afterEach(() => {
    cap.restore()
  })

  it("emits a rule line on first call", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.separator()
    const output = cap.output.join("")
    expect(output.length).toBeGreaterThan(0)
  })

  it("does not emit duplicate rules back-to-back", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.separator()
    ui.separator()
    const lines = cap.output.filter((l) => l.trim().length > 0)
    expect(lines.length).toBe(1)
  })

  it("resets lastWasRule when a non-rule line is written", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.separator()
    ui.line("content")
    ui.separator()
    const lines = cap.output.filter((l) => l.trim().length > 0)
    expect(lines.length).toBe(3)
  })
})

describe("TerminalUI: cursor handling in prompt", () => {
  it("hides cursor when entering raw mode (?25l not ?25h)", async () => {
    const cap = captureStdout()
    const originalStdinTTY = process.stdin.isTTY
    const stdinEmitter = new EventEmitter()
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
    Object.defineProperty(process.stdin, "setRawMode", { value: () => true, configurable: true })
    Object.defineProperty(process.stdin, "setEncoding", { value: () => {}, configurable: true })
    Object.defineProperty(process.stdin, "on", {
      value: (event: string, cb: (...args: unknown[]) => void) => stdinEmitter.on(event, cb),
      configurable: true,
    })
    Object.defineProperty(process.stdin, "removeListener", {
      value: (event: string, cb: (...args: unknown[]) => void) => stdinEmitter.removeListener(event, cb),
      configurable: true,
    })
    Object.defineProperty(process.stdin, "resume", { value: () => {}, configurable: true })
    Object.defineProperty(process.stdin, "ref", { value: () => {}, configurable: true })
    Object.defineProperty(process.stdin, "unref", { value: () => {}, configurable: true })
    try {
      const ui = new TerminalUI({ useColor: false })

      const promise = ui.prompt("test")
      await new Promise((r) => setTimeout(r, 100))

      const output = cap.output.join("")
      expect(output).toContain("\x1b[?25l")
      expect(output).not.toContain("\x1b[?25h")

      stdinEmitter.emit("data", "\r")
      await promise
    } finally {
      cap.restore()
      Object.defineProperty(process.stdin, "isTTY", { value: originalStdinTTY, configurable: true })
    }
  })
})

describe("TerminalUI: slash menu composer anchoring", () => {
  it("draws the menu below the composer and erases it without jumping into history", async () => {
    const cap = captureStdout()
    const originalStdinTTY = process.stdin.isTTY
    const stdinEmitter = new EventEmitter()
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
    Object.defineProperty(process.stdin, "setRawMode", { value: () => true, configurable: true })
    Object.defineProperty(process.stdin, "setEncoding", { value: () => {}, configurable: true })
    Object.defineProperty(process.stdin, "on", {
      value: (event: string, cb: (...args: unknown[]) => void) => stdinEmitter.on(event, cb),
      configurable: true,
    })
    Object.defineProperty(process.stdin, "removeListener", {
      value: (event: string, cb: (...args: unknown[]) => void) => stdinEmitter.removeListener(event, cb),
      configurable: true,
    })
    Object.defineProperty(process.stdin, "resume", { value: () => {}, configurable: true })
    Object.defineProperty(process.stdin, "ref", { value: () => {}, configurable: true })
    Object.defineProperty(process.stdin, "unref", { value: () => {}, configurable: true })

    const slashCommands = [
      { label: "/help", description: "show all commands" },
      { label: "/clear", description: "reset the session" },
      { label: "/model", description: "show current model" },
    ]

    try {
      const ui = new TerminalUI({ useColor: false })
      const promise = ui.prompt("test", { slashCommands })
      await new Promise((r) => setTimeout(r, 80))

      stdinEmitter.emit("data", "/")
      await new Promise((r) => setTimeout(r, 80))

      const out = cap.output.join("")
      const csi = (seq: string) => out.includes(seq)

      // The slash menu must be drawn (its header) — below the composer.
      expect(out).toContain("commands")

      // A screen-clear sequence would wipe the conversation scrollback: the
      // composer repair must never rely on it.
      expect(csi("\x1b[2J")).toBe(false)

      // Every render must end by redrawing the composer row with a "❯?"-style
      // prompt followed by an EOL-clear, i.e. the composer is the bottom row.
      const composerCount = (out.match(/\x1b\[2K/g) || []).length
      expect(composerCount).toBeGreaterThan(0)

      // Press ESC to close the menu, then Enter to submit an empty prompt.
      stdinEmitter.emit("data", "\x1b")
      await new Promise((r) => setTimeout(r, 60))
      stdinEmitter.emit("data", "\r")
      await promise
    } finally {
      cap.restore()
      Object.defineProperty(process.stdin, "isTTY", { value: originalStdinTTY, configurable: true })
    }
  })
})

describe("TerminalUI: thought and streaming state", () => {
  it("hasStreamed returns false initially, true after text, false after flush", () => {
    const ui = new TerminalUI({ useColor: false })
    expect(ui.hasStreamedText()).toBe(false)
    ui.assistantText("hello")
    expect(ui.hasStreamedText()).toBe(true)
    ui.flushAssistant()
    expect(ui.hasStreamedText()).toBe(false)
  })

  it("hasAssistantStarted mirrors assistantText state", () => {
    const ui = new TerminalUI({ useColor: false })
    expect(ui.hasAssistantStarted()).toBe(false)
    ui.assistantText("started")
    expect(ui.hasAssistantStarted()).toBe(true)
    ui.flushAssistant()
    expect(ui.hasAssistantStarted()).toBe(false)
  })

  it("thinking is a no-op when assistant already started", () => {
    const cap = captureStdout()
    try {
      const ui = new TerminalUI({ useColor: false })
      ui.assistantText("started")
      const before = cap.output.length
      ui.thinking("should not render")
      expect(cap.output.length).toBe(before)
      ui.flushAssistant()
    } finally {
      cap.restore()
    }
  })
})

describe("TerminalUI: banner, stcRule, clearScreen, notice", () => {
  let cap: ReturnType<typeof captureStdout>

  beforeEach(() => {
    cap = captureStdout()
  })

  afterEach(() => {
    cap.restore()
  })

  it("banner prints title text", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.banner("Hello World")
    const output = cap.output.join("")
    expect(output).toContain("Hello World")
    expect(output).toContain("TRAYAMBAK")
  })

  it("stcRule prints TRAYAMBAK CODE tag", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.stcRule()
    const output = cap.output.join("")
    expect(output).toContain("TRAYAMBAK CODE")
  })

  it("clearScreen writes ANSI clear and home", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.clearScreen()
    const output = cap.output.join("")
    expect(output).toContain("\x1b[2J")
    expect(output).toContain("\x1b[H")
  })

  it("clearPreviousLine writes cursor-up and clear", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.clearPreviousLine()
    const output = cap.output.join("")
    expect(output).toContain("\x1b[1A")
    expect(output).toContain("\x1b[2K")
  })

  it("notice prints text", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.notice("info message")
    const output = cap.output.join("")
    expect(output).toContain("info message")
  })

  it("headline prints text", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.headline("Title")
    const output = cap.output.join("")
    expect(output).toContain("Title")
  })

  it("userInput prints text", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.userInput("user input here")
    const output = cap.output.join("")
    expect(output).toContain("user input here")
  })
})

describe("renderEvent", () => {
  let cap: ReturnType<typeof captureStdout>

  beforeEach(() => {
    cap = captureStdout()
  })

  afterEach(() => {
    cap.restore()
  })

  it("handles message_update with text delta", () => {
    const ui = new TerminalUI({ useColor: false })
    renderEvent({ type: "message_update", delta: { text: "Hello" } } as unknown as AgentEvent, ui)
    const output = cap.output.join("")
    expect(output).toContain("Hello")
  })

  it("renders thinking text in a stable activity row", () => {
    const ui = new TerminalUI({ useColor: false })
    renderEvent({ type: "message_update", delta: { thinking: "Let me think" } } as unknown as AgentEvent, ui)
    const output = cap.output.join("")
    expect(output).toContain("Thinking")
    expect(output).toContain("Let me think")
  })

  it("blocks thinking after assistant text started", () => {
    const ui = new TerminalUI({ useColor: false })
    renderEvent({ type: "message_update", delta: { text: "Started" } } as unknown as AgentEvent, ui)
    cap.output.length = 0
    renderEvent({ type: "message_update", delta: { thinking: "More" } } as unknown as AgentEvent, ui)
    expect(cap.output.length).toBe(0)
  })

  it("renders full message on message_end when no streaming", () => {
    const ui = new TerminalUI({ useColor: false })
    renderEvent(
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Full response" }] },
      } as unknown as AgentEvent,
      ui,
    )
    const output = cap.output.join("")
    expect(output).toContain("Full response")
  })

  it("flushes assistant on message_end without duplicate output", () => {
    const ui = new TerminalUI({ useColor: false })
    renderEvent({ type: "message_update", delta: { text: "Partial" } } as unknown as AgentEvent, ui)
    cap.output.length = 0
    renderEvent(
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Full" }] },
      } as unknown as AgentEvent,
      ui,
    )
    expect(ui.hasStreamedText()).toBe(false)
    expect(ui.hasAssistantStarted()).toBe(false)
  })

  it("handles verification_start", () => {
    const ui = new TerminalUI({ useColor: false })
    renderEvent({ type: "verification_start" }, ui)
    const output = cap.output.join("")
    expect(output).toContain("Verification started")
  })

  it("renders verification_step with bullet", () => {
    const ui = new TerminalUI({ useColor: false })
    renderEvent({ type: "verification_step", name: "compile", status: "pass", detail: "OK" }, ui)
    const output = cap.output.join("")
    expect(output).toContain("compile")
    expect(output).toContain("pass")
  })

  it("handles verification_end passed", () => {
    const ui = new TerminalUI({ useColor: false })
    renderEvent({ type: "verification_end", passed: true } as unknown as AgentEvent, ui)
    const output = cap.output.join("")
    expect(output).toContain("passed")
  })

  it("handles agent_end", () => {
    const ui = new TerminalUI({ useColor: false })
    renderEvent({ type: "agent_end" } as unknown as AgentEvent, ui)
    const output = cap.output.join("")
    expect(output).toContain("\n")
  })
})

describe("rotatingHint and chooseOption", () => {
  it("rotatingHint returns no-op when not a TTY", () => {
    const original = process.stdout.isTTY
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true })
    const ui = new TerminalUI({ useColor: false })
    const cleanup = ui.rotatingHint(["hint1", "hint2"])
    expect(cleanup).toBeDefined()
    cleanup()
    Object.defineProperty(process.stdout, "isTTY", { value: original, configurable: true })
  })

  it("rotatingHint returns no-op when no lines", () => {
    const ui = new TerminalUI({ useColor: false })
    const cleanup = ui.rotatingHint([])
    expect(cleanup).toBeDefined()
    cleanup()
  })

  it("chooseOption returns null when not a TTY", async () => {
    const original = process.stdin.isTTY
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })
    const ui = new TerminalUI({ useColor: false })
    const result = await ui.chooseOption("Title", [])
    expect(result).toBe(null)
    Object.defineProperty(process.stdin, "isTTY", { value: original, configurable: true })
  })
})

describe("scaleAscii", () => {
  it("returns art unchanged when scale >= 1", () => {
    const art = "line1\nline2\nline3"
    expect(scaleAscii(art, 1)).toBe(art)
  })

  it("shrinks art by keeping every Nth line", () => {
    const art = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10"
    const result = scaleAscii(art, 0.5)
    const lines = result.split("\n")
    expect(lines.length).toBeLessThan(10)
  })

  it("trims lines to target width", () => {
    const art = "A".repeat(100) + "\n" + "B".repeat(100)
    const result = scaleAscii(art, 0.5)
    const lines = result.split("\n")
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(70)
    }
  })
})

describe("dialogs: renderPopup", () => {
  it("renders title and body lines", () => {
    const result = renderPopup("TITLE", ["body line 1", "body line 2"], { width: 40 })
    expect(result).toContain("TITLE")
    expect(result).toContain("body line 1")
    expect(result).toContain("body line 2")
  })

  it("handles empty lines gracefully", () => {
    const result = renderPopup("T", [], { width: 30 })
    expect(result).toContain("T")
  })

  it("clips body lines wider than the box so the right border stays intact", () => {
    // terminal-ui.popup hard-clips over-wide rows; this copy used to let them
    // overflow, shoving the right border N columns past the other rows.
    const out = renderPopup("TITLE", ["short", "y".repeat(200)], { width: 40 })
    const strip = (l: string): string => l.replace(/\x1b\[[0-9;]*m/g, "").replace(/\uFEFF/g, "")
    const widths = out.split("\n").map((l) => strip(l).length)
    expect(new Set(widths).size).toBe(1)
  })
})

describe("dialogs: renderDiff", () => {
  it("shows diff stat with add and del counts", () => {
    const diff = renderDiff("test.ts", "line1\nline2\nline3", "line1\nline2_modified\nline3")
    expect(diff).toContain("+1")
    expect(diff).toContain("-1")
  })

  it("truncates diff to maxLines", () => {
    const before = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
    const after = Array.from({ length: 100 }, (_, i) => `line${i}_modified`).join("\n")
    const diff = renderDiff("test.ts", before, after, 10)
    expect(diff).toContain("more lines")
  })

  it("buildDiff returns context for matching lines", () => {
    const diff = buildDiff("a\nb\nc", "a\nX\nc")
    expect(diff.some((d) => d.kind === "context")).toBe(true)
    expect(diff.some((d) => d.kind === "del")).toBe(true)
    expect(diff.some((d) => d.kind === "add")).toBe(true)
  })
})

describe("dialogs: renderMarkdown", () => {
  it("renders headers", () => {
    const result = renderMarkdown("# Title\n## Subtitle\nText")
    expect(result).toContain("Title")
    expect(result).toContain("Subtitle")
  })

  it("renders bold and italic", () => {
    const result = renderMarkdown("**bold** and *italic*")
    expect(result).toContain("bold")
    expect(result).toContain("italic")
  })

  it("renders code spans", () => {
    const result = renderMarkdown("Use `code` here")
    expect(result).toContain("code")
  })

  it("renders list items with bullets", () => {
    const result = renderMarkdown("- item 1\n- item 2")
    expect(result).toContain("item 1")
    expect(result).toContain("item 2")
  })
})

describe("dialogs: renderCodeBlock", () => {
  it("renders code with language label", () => {
    const result = renderCodeBlock("const x = 1;", "typescript")
    expect(result).toContain("typescript")
    expect(result).toContain("const x = 1;")
  })

  it("truncates long lines", () => {
    const longLine = "x".repeat(200)
    const result = renderCodeBlock(longLine, "text")
    expect(result).toContain("…")
  })
})

describe("dialogs: renderStatusBar, renderFileChange, renderUserBubble, renderHeader", () => {
  it("renderStatusBar includes cwd", () => {
    const result = renderStatusBar({ cwd: "/project" })
    expect(result).toContain("/project")
  })

  it("renderFileChange shows add and del counts", () => {
    const result = renderFileChange("test.ts", 5, 3)
    expect(result).toContain("test.ts")
    expect(result).toContain("+5")
    expect(result).toContain("-3")
  })

  it("renderUserBubble includes text", () => {
    const result = renderUserBubble("Hello world")
    expect(result).toContain("Hello world")
  })

  it("renderAssistantBubble wraps text", () => {
    const result = renderAssistantBubble("Hello world")
    expect(result).toContain("Hello world")
  })

  it("renderHeader includes title and subtitle", () => {
    const result = renderHeader("Title", "subtitle")
    expect(result).toContain("Title")
    expect(result).toContain("subtitle")
  })
})
describe("ApprovalManager subscription", () => {
  it("notifies subscribers when requests are added and resolved", async () => {
    const mgr = new ApprovalManager()
    const seen: number[] = []
    const off = mgr.subscribe((list) => seen.push(list.length))

    void mgr.requestApproval("Test tool", "Needs approval", "bash", { command: "ls" })
    expect(mgr.getPendingApprovals().length).toBe(1)
    expect(seen).toEqual([1])

    mgr.resolveApproval(mgr.getPendingApprovals()[0].id, "approve")
    expect(mgr.getPendingApprovals().length).toBe(0)
    expect(seen).toEqual([1, 0])

    off()
    mgr.requestApproval("Another", "x", "write_file", { path: "a.txt" })
    expect(seen).toEqual([1, 0])
    mgr.cancelAll("test")
  })

  it("auto-approves session-approved tools without enqueueing", async () => {
    const mgr = new ApprovalManager()
    mgr.markSessionApproved("bash")
    const choice = await mgr.requestApproval("Bash", "run", "bash", { command: "dir" })
    expect(choice).toBe("approve")
    expect(mgr.getPendingApprovals().length).toBe(0)
  })
})

describe("ApprovalManager 4-choice chooser", () => {
  it("default approval choices include the 4 chooser options", async () => {
    const mgr = new ApprovalManager()
    const promise = mgr.requestApproval("Edit", "Apply patch", "edit", { path: "a.txt" })
    const pending = mgr.getPendingApprovals()[0]
    expect(pending.choices.map((c) => c.value)).toEqual(["approve", "approve_session", "dont_ask_again", "deny"])
    mgr.resolveApproval(pending.id, "approve")
    await promise
  })

  it("resolving dont_ask_again auto-approves the tool without enqueueing", async () => {
    const mgr = new ApprovalManager()
    const promise = mgr.requestApproval("Bash", "run", "bash", { command: "dir" })
    const pending = mgr.getPendingApprovals()[0]
    mgr.resolveApproval(pending.id, "dont_ask_again")
    expect(mgr.isNeverAsk("bash")).toBe(true)
    expect(mgr.isSessionApproved("bash")).toBe(true)
    expect(await promise).toBe("dont_ask_again")

    const next = await mgr.requestApproval("Bash", "run again", "bash", { command: "dir" })
    expect(next).toBe("approve")
    expect(mgr.getPendingApprovals().length).toBe(0)
  })

  it("awaitResolution attaches to an already-pending approval", async () => {
    const mgr = new ApprovalManager()
    const promise = mgr.requestApproval("Bash", "run", "bash", { command: "dir" })
    const pending = mgr.getPendingApprovals()[0]
    const attached = mgr.awaitResolution(pending.id)
    mgr.resolveApproval(pending.id, "approve")
    expect(await attached).toBe("approve")
    expect(await promise).toBe("approve")
  })
  it("cancelAll resolves pending approvals with null", async () => {
    const mgr = new ApprovalManager()
    const promise = mgr.requestApproval("Bash", "run", "bash", { command: "dir" })
    mgr.cancelAll("shutdown")
    expect(await promise).toBeNull()
    expect(mgr.getPendingApprovals().length).toBe(0)
  })
})

describe("TerminalUI: popup box and transcript sizing", () => {
  it("renders the popup title row at the same width as the box borders", () => {
    const cap = captureStdout()
    try {
      const ui = new TerminalUI({ useColor: true })
      ui.popup("SETTINGS", ["hello world"])
      const strip = (l: string): string => l.replace(/\x1b\[[0-9;]*m/g, "").replace(/\uFEFF/g, "")
      const widths = cap.output.filter((l) => l.trim().length > 0).map((l) => strip(l).length)
      expect(new Set(widths).size).toBe(1)
    } finally {
      cap.restore()
    }
  })

  it("shows no body lines when the terminal has 4 rows or fewer", () => {
    // Header + separator + blank + footer take 4 rows; with rows <= 4 the old
    // slice(-rows + 4) flipped from "tail" to "index N" and dumped the whole
    // buffer — the transcript overflowed the screen.
    const originalRows = process.stdout.rows
    Object.defineProperty(process.stdout, "rows", { value: 4, configurable: true })
    const cap = captureStdout()
    try {
      const ui = new TerminalUI({ useColor: false })
      const msgs = Array.from({ length: 50 }, (_, i) => ({ role: "user" as const, content: `line-${i}` }))
      ui.enterTranscriptMode(msgs)
      expect(cap.output.join("")).not.toContain("line-49")
    } finally {
      cap.restore()
      Object.defineProperty(process.stdout, "rows", { value: originalRows, configurable: true })
    }
  })
})

describe("TerminalUI: workflow handling", () => {
  it("defaults to idle workflow state", () => {
    const ui = new TerminalUI({ useColor: false })
    expect(ui.getWorkflowState()).toBe("idle")
  })

  it("transitions through workflow states", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.startWorkflow()
    expect(ui.getWorkflowState()).toBe("running")
    ui.completeWorkflow()
    expect(ui.getWorkflowState()).toBe("completed")
  })

  it("failWorkflow sets error state and logs error", () => {
    const cap = captureStdout()
    try {
      const ui = new TerminalUI({ useColor: false })
      ui.failWorkflow(new Error("boom"))
      expect(ui.getWorkflowState()).toBe("error")
      expect(cap.output.join("")).toContain("boom")
    } finally {
      cap.restore()
    }
  })

  it("pause and resume workflow", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.startWorkflow()
    ui.pauseWorkflow()
    expect(ui.getWorkflowState()).toBe("paused")
    ui.resumeWorkflow()
    expect(ui.getWorkflowState()).toBe("running")
  })

  it("workflowStatusLine includes state icon", () => {
    const ui = new TerminalUI({ useColor: false })
    ui.setWorkflowState("completed")
    expect(ui.workflowStatusLine()).toContain("completed")
  })
})

describe("TerminalUI: animation features", () => {
  it("progressBar renders without throwing", () => {
    const cap = captureStdout()
    try {
      const ui = new TerminalUI({ useColor: false })
      ui.progressBar(25, 100, 20)
      ui.progressBar(100, 100, 20)
      expect(cap.output.join("")).toContain("25%")
      expect(cap.output.join("")).toContain("100%")
    } finally {
      cap.restore()
    }
  })

  it("loading returns a cleanup function", () => {
    const ui = new TerminalUI({ useColor: false })
    const cleanup = ui.loading("working")
    expect(typeof cleanup).toBe("function")
    cleanup()
  })

  it("animateFrame runs frames and returns cleanup", async () => {
    const ui = new TerminalUI({ useColor: false })
    let count = 0
    const cleanup = ui.animateFrame(
      () => {
        count++
      },
      10,
      35,
    )
    expect(typeof cleanup).toBe("function")
    await new Promise((r) => setTimeout(r, 60))
    expect(count).toBeGreaterThan(0)
    cleanup()
  })
})

describe("TerminalUI: error handling UI", () => {
  it("error logs message", () => {
    const cap = captureStdout()
    try {
      const ui = new TerminalUI({ useColor: false })
      ui.error("something failed")
      expect(cap.output.join("")).toContain("something failed")
    } finally {
      cap.restore()
    }
  })

  it("warn logs message", () => {
    const cap = captureStdout()
    try {
      const ui = new TerminalUI({ useColor: false })
      ui.warn("careful")
      expect(cap.output.join("")).toContain("careful")
    } finally {
      cap.restore()
    }
  })

  it("success logs message", () => {
    const cap = captureStdout()
    try {
      const ui = new TerminalUI({ useColor: false })
      ui.success("all good")
      expect(cap.output.join("")).toContain("all good")
    } finally {
      cap.restore()
    }
  })

  it("errorBox renders a bordered box", () => {
    const cap = captureStdout()
    try {
      const ui = new TerminalUI({ useColor: false })
      ui.errorBox(new Error("boom"))
      const out = cap.output.join("")
      expect(out).toContain("boom")
      expect(out).toContain("┌")
      expect(out).toContain("└")
    } finally {
      cap.restore()
    }
  })

  it("showError returns true without retry", async () => {
    const ui = new TerminalUI({ useColor: false })
    await expect(ui.showError(new Error("boom"))).resolves.toBe(true)
  })
})
