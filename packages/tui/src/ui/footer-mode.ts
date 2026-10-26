/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Portions derived from OpenAI Codex CLI (codex-rs), Copyright 2025 OpenAI,
 * licensed under the Apache License, Version 2.0. See THIRD_PARTY_NOTICES.md.
 */

/**
 * Port of the Codex reference `footer.rs` and `shimmer.rs`
 * — the FooterMode enum, FooterKeyHints, FooterProps, single-line collapse
 * layout, and time-based shimmer animation.
 */

import { paint, BOLD, DIM } from "./theme"

export const FOOTER_INDENT_COLS = 2
const FOOTER_CONTEXT_GAP_COLS = 1
const MODE_CYCLE_HINT = "shift+tab to cycle"

export type FooterKeyBinding = { key: string; display: string }

export type FooterKeyHints = {
  toggleShortcuts?: FooterKeyBinding | null
  queue?: FooterKeyBinding | null
  insertNewline?: FooterKeyBinding | null
  externalEditor?: FooterKeyBinding | null
  editPrevious?: FooterKeyBinding | null
  showTranscript?: FooterKeyBinding | null
  historySearch?: FooterKeyBinding | null
  reasoningDown?: FooterKeyBinding | null
  reasoningUp?: FooterKeyBinding | null
}

export const DEFAULT_FOOTER_KEY_HINTS: FooterKeyHints = {
  toggleShortcuts: { key: "?", display: "?" },
  queue: { key: "Tab", display: "Tab" },
  insertNewline: { key: "Ctrl+J", display: "Ctrl+J" },
  externalEditor: { key: "Ctrl+G", display: "Ctrl+G" },
  editPrevious: { key: "Esc", display: "Esc" },
  showTranscript: { key: "Ctrl+T", display: "Ctrl+T" },
  historySearch: { key: "Ctrl+R", display: "Ctrl+R" },
  reasoningDown: { key: "Alt+,", display: "Alt+," },
  reasoningUp: { key: "Alt+.", display: "Alt+." },
}

export type FooterMode =
  "HistorySearch" | "QuitShortcutReminder" | "ShortcutOverlay" | "EscHint" | "ComposerEmpty" | "ComposerHasDraft"

export type CollaborationModeIndicator = "Plan"

export type GoalStatusIndicator =
  | { kind: "Active"; usage?: string }
  | { kind: "Paused" }
  | { kind: "Blocked" }
  | { kind: "UsageLimited" }
  | { kind: "BudgetLimited"; usage?: string }
  | { kind: "Complete"; usage?: string }

export type FooterProps = {
  mode: FooterMode
  escBacktrackHint: boolean
  useShiftEnterHint: boolean
  isTaskRunning: boolean
  queueSubmissions: boolean
  collaborationModesEnabled: boolean
  isWsl: boolean
  quitShortcutKey: FooterKeyBinding
  statusLineValue?: string | null
  statusLineEnabled: boolean
  keyHints: FooterKeyHints
  activeAgentLabel?: string | null
  contextPercent?: number | null
  usedTokens?: number | null
}

export function toggleShortcutMode(current: FooterMode, ctrlCHint: boolean, isEmpty: boolean): FooterMode {
  if (ctrlCHint && current === "QuitShortcutReminder") return current
  const base: FooterMode = isEmpty ? "ComposerEmpty" : "ComposerHasDraft"
  if (current === "ShortcutOverlay" || current === "QuitShortcutReminder") return base
  return "ShortcutOverlay"
}

export function escHintMode(current: FooterMode, isTaskRunning: boolean): FooterMode {
  if (isTaskRunning) return current
  return "EscHint"
}

export function resetModeAfterActivity(current: FooterMode): FooterMode {
  if (
    current === "EscHint" ||
    current === "ShortcutOverlay" ||
    current === "QuitShortcutReminder" ||
    current === "HistorySearch" ||
    current === "ComposerHasDraft"
  ) {
    return "ComposerEmpty"
  }
  return current
}

function visibleWidth(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length
}

function collaborationLabel(mode: CollaborationModeIndicator, showCycleHint: boolean): string {
  const suffix = showCycleHint ? ` (${MODE_CYCLE_HINT})` : ""
  if (mode === "Plan") return `Plan mode${suffix}`
  return `${mode}${suffix}`
}

function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function contextWindowLine(props: FooterProps): string {
  if (typeof props.contextPercent === "number") {
    const pct = Math.max(0, Math.min(100, props.contextPercent))
    return paint("textMuted", `${pct}% context left`)
  }
  if (typeof props.usedTokens === "number") {
    return paint("textMuted", `${formatTokensCompact(props.usedTokens)} used`)
  }
  return paint("textMuted", "100% context left")
}

type SummaryHintKind = "None" | "Shortcuts" | "QueueMessage" | "QueueShort"

type LeftSideState = { hint: SummaryHintKind; showCycleHint: boolean }

function leftSideLine(
  collab: CollaborationModeIndicator | null,
  state: LeftSideState,
  keyHints: FooterKeyHints,
): string {
  const parts: string[] = []
  switch (state.hint) {
    case "None":
      break
    case "Shortcuts":
      if (keyHints.toggleShortcuts) {
        parts.push(paint("text", BOLD + keyHints.toggleShortcuts.display))
        parts.push(paint("textMuted", " for shortcuts"))
      }
      break
    case "QueueMessage":
      if (keyHints.queue) {
        parts.push(paint("text", BOLD + keyHints.queue.display))
        parts.push(paint("textMuted", " to queue message"))
      }
      break
    case "QueueShort":
      if (keyHints.queue) {
        parts.push(paint("text", BOLD + keyHints.queue.display))
        parts.push(paint("textMuted", " to queue"))
      }
      break
  }
  if (collab) {
    if (state.hint !== "None") parts.push(paint("textMuted", "  ·  "))
    parts.push(paint("accent", BOLD + collaborationLabel(collab, state.showCycleHint)))
  }
  return parts.join("")
}

function rightAlignedX(area: { width: number }, contentWidth: number): number | null {
  if (area.width <= 0) return null
  const rightPad = FOOTER_INDENT_COLS
  const max = area.width - rightPad
  if (contentWidth === 0 || max <= 0) return null
  if (contentWidth >= max) return rightPad
  return area.width - contentWidth - rightPad
}

function canShowLeftWithContext(area: { width: number }, leftWidth: number, contextWidth: number): boolean {
  const x = rightAlignedX(area, contextWidth)
  if (x === null) return true
  if (leftWidth === 0) return true
  const leftExtent = FOOTER_INDENT_COLS + leftWidth + FOOTER_CONTEXT_GAP_COLS
  return leftExtent <= x
}

function leftFits(area: { width: number }, leftWidth: number): boolean {
  const max = Math.max(0, area.width - FOOTER_INDENT_COLS)
  return leftWidth <= max
}

function maxLeftWidthForRight(area: { width: number }, rightWidth: number): number | null {
  const contextX = rightAlignedX(area, rightWidth)
  if (contextX === null) return null
  const leftStart = FOOTER_INDENT_COLS
  const gap = FOOTER_CONTEXT_GAP_COLS
  if (contextX <= leftStart + gap) return 0
  return contextX - leftStart - gap
}

export type SummaryLeft = { kind: "Default" } | { kind: "Custom"; line: string } | { kind: "None" }

export function singleLineFooterLayout(
  area: { width: number },
  contextWidth: number,
  collab: CollaborationModeIndicator | null,
  showCycleHint: boolean,
  showShortcutsHint: boolean,
  showQueueHint: boolean,
  keyHints: FooterKeyHints,
): { left: SummaryLeft; showContext: boolean } {
  const hintKind: SummaryHintKind = showQueueHint ? "QueueMessage" : showShortcutsHint ? "Shortcuts" : "None"
  const defaultState: LeftSideState = { hint: hintKind, showCycleHint }
  const defaultLine = leftSideLine(collab, defaultState, keyHints)
  const defaultWidth = visibleWidth(defaultLine)

  if (defaultWidth > 0 && canShowLeftWithContext(area, defaultWidth, contextWidth)) {
    return { left: { kind: "Default" }, showContext: true }
  }

  const stateLine = (state: LeftSideState): string =>
    state.hint === defaultState.hint && state.showCycleHint === defaultState.showCycleHint
      ? defaultLine
      : leftSideLine(collab, state, keyHints)
  const stateWidth = (state: LeftSideState): number => visibleWidth(stateLine(state))

  const contextRequiresCycleHint = showCycleHint && !showQueueHint

  if (showQueueHint) {
    const queueStates: LeftSideState[] = [
      defaultState,
      { hint: "QueueMessage", showCycleHint: false },
      { hint: "QueueShort", showCycleHint: false },
    ]
    let prev: LeftSideState | null = null
    for (const state of queueStates) {
      if (prev && prev.hint === state.hint && prev.showCycleHint === state.showCycleHint) continue
      prev = state
      const w = stateWidth(state)
      if (w > 0 && canShowLeftWithContext(area, w, contextWidth)) {
        if (state.hint === defaultState.hint && state.showCycleHint === defaultState.showCycleHint) {
          return { left: { kind: "Default" }, showContext: true }
        }
        return { left: { kind: "Custom", line: stateLine(state) }, showContext: true }
      }
    }
    prev = null
    for (const state of queueStates) {
      if (prev && prev.hint === state.hint && prev.showCycleHint === state.showCycleHint) continue
      prev = state
      const w = stateWidth(state)
      if (w > 0 && leftFits(area, w)) {
        if (state.hint === defaultState.hint && state.showCycleHint === defaultState.showCycleHint) {
          return { left: { kind: "Default" }, showContext: false }
        }
        return { left: { kind: "Custom", line: stateLine(state) }, showContext: false }
      }
    }
  } else if (collab) {
    if (showCycleHint) {
      const cycleState: LeftSideState = { hint: "None", showCycleHint: true }
      const cycleWidth = stateWidth(cycleState)
      if (cycleWidth > 0 && canShowLeftWithContext(area, cycleWidth, contextWidth)) {
        return { left: { kind: "Custom", line: stateLine(cycleState) }, showContext: true }
      }
      if (cycleWidth > 0 && leftFits(area, cycleWidth)) {
        return { left: { kind: "Custom", line: stateLine(cycleState) }, showContext: false }
      }
    }
    const modeOnly: LeftSideState = { hint: "None", showCycleHint: false }
    const modeOnlyWidth = stateWidth(modeOnly)
    if (!contextRequiresCycleHint && modeOnlyWidth > 0 && canShowLeftWithContext(area, modeOnlyWidth, contextWidth)) {
      return { left: { kind: "Custom", line: stateLine(modeOnly) }, showContext: true }
    }
    if (modeOnlyWidth > 0 && leftFits(area, modeOnlyWidth)) {
      return { left: { kind: "Custom", line: stateLine(modeOnly) }, showContext: false }
    }
  }

  if (collab) {
    const modeOnly: LeftSideState = { hint: "None", showCycleHint: false }
    const modeOnlyWidth = leftSideLine(collab, modeOnly, keyHints).length
    if (!contextRequiresCycleHint && canShowLeftWithContext(area, modeOnlyWidth, contextWidth)) {
      return {
        left: { kind: "Custom", line: leftSideLine(collab, modeOnly, keyHints) },
        showContext: true,
      }
    }
    if (leftFits(area, modeOnlyWidth)) {
      return {
        left: { kind: "Custom", line: leftSideLine(collab, modeOnly, keyHints) },
        showContext: false,
      }
    }
  }

  return { left: { kind: "None" }, showContext: true }
}

function shortcutOverlayLines(
  isTaskRunning: boolean,
  queueSubmissions: boolean,
  useShiftEnterHint: boolean,
  escBacktrackHint: boolean,
  isWsl: boolean,
  collabEnabled: boolean,
  keyHints: FooterKeyHints,
): string[] {
  const line = (prefix: string, keyDisplay: string, label: string, extraKey?: string): string => {
    const keyPart = paint("text", BOLD + keyDisplay)
    if (extraKey) {
      return `${prefix}${keyPart} ${paint("textMuted", label)} ${paint("text", BOLD + extraKey)}`
    }
    return `${prefix}${keyPart}${paint("textMuted", label)}`
  }

  const slashKey = keyHints.toggleShortcuts?.display ?? "/"
  const commands = line("", slashKey, " for commands")

  const bangKey = { key: "!", display: "!" }
  const shellCommands = line("", bangKey.display, " for shell commands")

  const newlineKey = useShiftEnterHint
    ? { key: "Shift+Enter", display: "Shift+Enter" }
    : (keyHints.insertNewline ?? { key: "Ctrl+J", display: "Ctrl+J" })
  const newline = line("", newlineKey.display, " for newline")

  const queueKey = keyHints.queue?.display ?? "Tab"
  const queueLabel = isTaskRunning || queueSubmissions ? " to queue message" : " to submit message"
  const queueMessageTab = line("", queueKey, queueLabel)

  const atKey = { key: "@", display: "@" }
  const filePaths = line("", atKey.display, " for file paths")

  const v = isWsl ? { key: "Ctrl+Alt+V", display: "Ctrl+Alt+V" } : { key: "Ctrl+V", display: "Ctrl+V" }
  const pasteImage = line("", isWsl ? v.display : v.display, " to paste images")

  const extKey = keyHints.externalEditor?.display ?? "Ctrl+G"
  const externalEditor = line("", extKey, " to edit in external editor")

  const escKey = keyHints.editPrevious?.display ?? "Esc"
  const editPrevious = escBacktrackHint
    ? line("", escKey, " again to edit previous message")
    : line("", escKey, " to edit previous message", escKey)

  const histKey = keyHints.historySearch?.display ?? "Ctrl+R"
  const historySearch = line("", histKey, " search history")

  const quitKey = { key: "Ctrl+C", display: "Ctrl+C" }
  const quit = line("", quitKey.display, isTaskRunning ? " to interrupt" : " to exit")

  const transcriptKey = keyHints.showTranscript?.display ?? "Ctrl+T"
  const showTranscript = line("", transcriptKey, " to view transcript")

  const modeKey = { key: "Shift+Tab", display: "Shift+Tab" }
  const changeMode = collabEnabled ? line("", modeKey.display, " to change mode") : ""

  const reasoningDownKey = keyHints.reasoningDown?.display ?? "Alt+,"
  const reasoningDown = line("", reasoningDownKey, " reasoning down")

  const reasoningUpKey = keyHints.reasoningUp?.display ?? "Alt+."
  const reasoningUp = line("", reasoningUpKey, " reasoning up")

  const ordered: string[] = [
    commands,
    shellCommands,
    newline,
    queueMessageTab,
    filePaths,
    pasteImage,
    externalEditor,
    editPrevious,
    historySearch,
    quit,
    reasoningDown,
    reasoningUp,
  ]
  if (changeMode) ordered.push(changeMode)
  ordered.push(showTranscript)

  const lines = buildColumns(ordered)
  lines.push("")
  lines.push(paint("textMuted", "customize shortcuts with ") + paint("accent", "/keymap"))
  return lines
}

function buildColumns(entries: string[]): string[] {
  if (entries.length === 0) return []
  const COLUMNS = 2
  const COLUMN_PADDING = [4, 4]
  const COLUMN_GAP = 4
  const rows = Math.ceil(entries.length / COLUMNS)
  const target = rows * COLUMNS
  const padded = [...entries]
  while (padded.length < target) padded.push("")

  const columnWidths = [0, 0]
  padded.forEach((entry, i) => {
    const col = i % COLUMNS
    columnWidths[col] = Math.max(columnWidths[col], visibleWidth(entry))
  })
  for (let i = 0; i < COLUMNS; i++) columnWidths[i] += COLUMN_PADDING[i]

  const rows2: string[] = []
  for (let r = 0; r < rows; r++) {
    const chunk = padded.slice(r * COLUMNS, r * COLUMNS + COLUMNS)
    let line = ""
    for (let c = 0; c < COLUMNS; c++) {
      const entry = chunk[c] ?? ""
      line += entry
      if (c < COLUMNS - 1) {
        const target = columnWidths[c]
        const pad = Math.max(0, target - visibleWidth(entry)) + COLUMN_GAP
        line += " ".repeat(pad)
      }
    }
    rows2.push(paint("textMuted", line))
  }
  return rows2
}

function passiveFooterStatusLine(props: FooterProps): string | null {
  if (!showsPassiveFooterLine(props)) return null
  let line: string | null = null
  if (props.statusLineEnabled && props.statusLineValue) {
    line = props.statusLineValue
  }
  if (props.activeAgentLabel) {
    if (line) line += paint("textMuted", "  ·  ") + paint("textMuted", props.activeAgentLabel)
    else line = paint("textMuted", props.activeAgentLabel)
  }
  return line
}

function showsPassiveFooterLine(props: FooterProps): boolean {
  switch (props.mode) {
    case "ComposerEmpty":
      return true
    case "ComposerHasDraft":
      return !props.isTaskRunning
    case "HistorySearch":
    case "QuitShortcutReminder":
    case "ShortcutOverlay":
    case "EscHint":
      return false
  }
}

function collaborationModeIndicatorLine(props: FooterProps, showCycleHint: boolean): string | null {
  if (!props.collaborationModesEnabled) return null
  return collaborationLabel("Plan", showCycleHint)
}

function rightSideContextLine(props: FooterProps, showCycleHint: boolean): string {
  const primary = collaborationModeIndicatorLine(props, showCycleHint)
  if (primary) return primary
  return contextWindowLine(props)
}

export function statusLineRightIndicatorLine(
  collab: CollaborationModeIndicator | null,
  showCycleHint: boolean,
  _props: FooterProps,
): string | null {
  return collab ? paint("accent", BOLD + collaborationLabel(collab, showCycleHint)) : null
}

function rightAlignedRender(area: { width: number }, _line: string, visibleContentWidth: number): string {
  const x = rightAlignedX(area, visibleContentWidth)
  if (x === null) return ""
  const pad = " ".repeat(Math.max(0, x - FOOTER_INDENT_COLS))
  return pad + _line
}

export type RenderedFooter = {
  leftLine: string | null
  rightLine: string | null
  height: number
  shortcutOverlay?: string[]
}

export function renderModeFooter(
  props: FooterProps,
  collab: CollaborationModeIndicator | null = null,
  area: { width: number } = { width: 80 },
): RenderedFooter {
  const showShortcutsHint = props.mode === "ComposerEmpty" && !props.isTaskRunning
  const showCycleHint = !props.isTaskRunning
  const showQueueHint = props.mode === "ComposerHasDraft" && props.isTaskRunning
  const passive = passiveFooterStatusLine(props)

  if (props.mode === "ShortcutOverlay") {
    return {
      leftLine: null,
      rightLine: null,
      height: 0,
      shortcutOverlay: shortcutOverlayLines(
        props.isTaskRunning,
        props.queueSubmissions,
        props.useShiftEnterHint,
        props.escBacktrackHint,
        props.isWsl,
        props.collaborationModesEnabled,
        props.keyHints,
      ),
    }
  }

  if (passive) {
    const passiveW = visibleWidth(passive)
    const right = rightSideContextLine(props, showCycleHint)
    const rightW = visibleWidth(right)
    const maxLeft = maxLeftWidthForRight(area, rightW)
    let leftToRender = passive
    if (maxLeft !== null && passiveW > maxLeft) {
      leftToRender = truncateWithEllipsis(passive, Math.max(0, maxLeft))
    }
    const leftW = visibleWidth(leftToRender)
    const fits = canShowLeftWithContext(area, leftW, rightW)
    return {
      leftLine: " ".repeat(FOOTER_INDENT_COLS) + leftToRender,
      rightLine: fits ? " ".repeat(FOOTER_INDENT_COLS) + rightAlignedRender(area, right, rightW) : null,
      height: 1,
    }
  }

  const { left, showContext } = singleLineFooterLayout(
    area,
    visibleWidth(rightSideContextLine(props, showCycleHint)),
    collab,
    showCycleHint,
    showShortcutsHint,
    showQueueHint,
    props.keyHints,
  )

  let leftLine: string | null = null
  if (left.kind === "Default") {
    if (props.mode === "QuitShortcutReminder") {
      leftLine = paint("textMuted", paint("text", BOLD + props.quitShortcutKey.display) + " again to quit")
    } else if (props.mode === "HistorySearch") {
      leftLine = paint("textMuted", "reverse-i-search: ")
    } else {
      const hintKind: SummaryHintKind = showQueueHint ? "QueueMessage" : showShortcutsHint ? "Shortcuts" : "None"
      leftLine = leftSideLine(collab, { hint: hintKind, showCycleHint }, props.keyHints)
    }
  } else if (left.kind === "Custom") {
    leftLine = left.line
  }

  const rightLine = showContext ? rightSideContextLine(props, showCycleHint) : null

  return {
    leftLine: leftLine ? " ".repeat(FOOTER_INDENT_COLS) + leftLine : null,
    rightLine: rightLine
      ? " ".repeat(FOOTER_INDENT_COLS) + rightAlignedRender(area, rightLine, visibleWidth(rightLine))
      : null,
    height: 1,
  }
}

function truncateWithEllipsis(s: string, max: number): string {
  const w = visibleWidth(s)
  if (w <= max) return s
  if (max <= 1) return "…"
  return s.slice(0, Math.max(0, max - 1)) + "…"
}

const PROCESS_START = Date.now()

/**
 * Port of the Codex reference `shimmer.rs` — time-based sweep animation.
 * Returns styled spans for the given text where a band of bright
 * characters sweeps across at a fixed period.
 */
export function shimmerSpans(text: string, opts: { sweepSeconds?: number } = {}): string[] {
  if (text.length === 0) return []
  const sweepSeconds = opts.sweepSeconds ?? 2.0
  const padding = 10
  const period = text.length + padding * 2
  const elapsed = (Date.now() - PROCESS_START) / 1000
  const pos = ((elapsed % sweepSeconds) / sweepSeconds) * period
  const bandHalfWidth = 5.0
  const out: string[] = []
  for (let i = 0; i < text.length; i++) {
    const iPos = i + padding
    const dist = Math.abs(iPos - pos)
    const t = dist <= bandHalfWidth ? 0.5 * (1 + Math.cos((Math.PI * dist) / bandHalfWidth)) : 0
    const intensity = Math.max(0, Math.min(1, t))
    const ch = text[i] ?? ""
    if (intensity < 0.2) {
      out.push(paint("textMuted", DIM + ch))
    } else if (intensity < 0.6) {
      out.push(paint("text", ch))
    } else {
      out.push(paint("text", BOLD + ch))
    }
  }
  return out
}
