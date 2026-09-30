/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

// Full UI component library (theme system, boxes, spinners, toasts, footer, dialogs)

import { g } from "./ink-app/glyphs.js"

export * from "./ui/index"

export * from "./approval-notification"

// -- Legacy (pre-ink) TUI tree — kept ALIVE: typechecked, emitted, exported --
// The raw-terminal state machine + composer + chat widget that predate the
// ink renderer. Their AppEvent/ApprovalRequest are DIFFERENT shapes from the
// live names above (ui types, approval-notification), so those two travel
// under state-machine-origin aliases — a plain `export *` from ./app/index
// would raise TS2308 on the ambiguity. Rect/Frame/DrawCallback/TerminalSize
// come from ./tui/terminal below; the legacy events module's same-shape
// copies stay internal to the tree.
export { AppState, type AppStateOptions } from "./app/index"
export type {
  AppEvent as AppStateEvent,
  ApprovalRequest as AppStateApprovalRequest,
  TrayambakConfig,
  PermissionRequest,
  PermissionResponse,
  ServerNotification,
  ServerRequest,
  ExitMode,
  AppExitInfo,
  TuiEvent,
  AppEventHandler,
} from "./app/index"
export { Composer, type ComposerOptions, type ComposerInputResult } from "./bottom_pane/index"
export { ChatWidget, type ChatMessageEntry, type ToolCallEntry, type ChatWidgetOptions } from "./chatwidget/index"
export * from "./tui/terminal"

// Keybinding tables: composer/select/approval defaults + the global chord
// docs rendered by /keymap (formatKeymapMessage) and the which-key overlay.
export {
  DEFAULT_KEYBINDINGS,
  GLOBAL_SHORTCUTS,
  createKeybindingRegistry,
  formatKeymapMessage,
  type GlobalShortcut,
  type KeybindingDefinition,
  type KeybindingRegistry,
  type KeybindingsConfig,
} from "./keybindings"

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

import { type TerminalUI } from "./terminal-ui.js"
export { COLOR, TerminalUI, type TerminalUIOptions, readClipboardText, scaleAscii } from "./terminal-ui.js"

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
