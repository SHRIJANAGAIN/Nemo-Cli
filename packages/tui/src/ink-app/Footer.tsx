/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { type ReactNode } from "react"
import { Box, Text, useStdout } from "ink"
import { Spinner } from "./Spinner.js"
import type { StatusBarInfo, BackgroundSubagentState } from "./types.js"
import { PERMISSION_MODE_LABELS, STATUS_LABELS, formatSubagentToolcalls } from "./types.js"
import { useThemeColors } from "./themeColors.js"
import { contextUsage } from "./sidebar-data.js"
import { fitFooter, SEGMENT_GAP, type FooterSegment } from "./footer-fit.js"
import { useBorderPulse } from "./use-border-pulse.js"

export interface FooterProps {
  info: StatusBarInfo
  backgroundSubagents?: Map<string, BackgroundSubagentState>
  subagentTabs?: BackgroundSubagentState[]
}

function subagentStatusIcon(status: BackgroundSubagentState["status"]): string {
  if (status === "completed") return "●"
  if (status === "cancelled") return "○"
  if (status === "error") return "✖"
  return "◍"
}

function subagentStatusColor(theme: ReturnType<typeof useThemeColors>, status: BackgroundSubagentState["status"]) {
  if (status === "completed") return theme.accent
  if (status === "cancelled") return theme.textMuted
  if (status === "error") return theme.error
  return theme.warning
}

function subagentLabel(item: BackgroundSubagentState): string {
  const elapsed = Math.floor((Date.now() - item.startedAt) / 1000)
  const label = `${item.name} (${elapsed}s)`
  if (item.result) {
    const toolcallSuffix = item.toolcalls ? ` — ${formatSubagentToolcalls(item.toolcalls)}` : ""
    return `${label}${toolcallSuffix} — completed`
  }
  return `${label} — running`
}

/** Three-tier key hints: the fit module picks the longest that shares the
 *  line with everything else, or drops hints entirely. */
function hintVariants(queued: number): string[] {
  const full = "ctrl+s inject / ctrl+g subagents / ctrl+b background / ctrl+k keys / ctrl+p commands"
  return [
    queued > 0 ? `${full} / ctrl+x clear queue` : full,
    "ctrl+s inject / ctrl+g sub / ctrl+b bg / ctrl+k keys",
    "ctrl+k/ctrl+p",
  ]
}

export const Footer = ({ info, backgroundSubagents, subagentTabs }: FooterProps): ReactNode => {
  const theme = useThemeColors()
  // Read columns directly at render time — deliberately NOT useWindowSize():
  // a columns subscription re-renders the WHOLE tree after a width resize,
  // which paints a second full frame right behind resize-guard's
  // blank+repaint (its contract: exactly one live frame — its smoke counts
  // Welcome frames). Footer re-fits on whatever render comes next instead
  // (same pattern as ModelPicker's stdout.columns read).
  const { stdout } = useStdout()
  const columns = stdout?.columns || 80
  const modeLabel = PERMISSION_MODE_LABELS[info.permissionMode]
  const tokenCount = info.tokenCount ?? 0
  const tokenColor = tokenCount >= 3000 ? theme.error : tokenCount >= 1000 ? theme.warning : theme.success
  const bgCount = info.backgroundCount ?? 0
  const queuedCount = info.queuedCount ?? 0

  // SKT AI LABS's context indicator: current tokens as a % of the model's window.
  const usage = contextUsage(tokenCount, info.contextWindow)
  const ctxColor =
    usage.percent === null
      ? theme.info
      : usage.percent >= 90
        ? theme.error
        : usage.percent >= 70
          ? theme.warning
          : theme.info

  const bgRunning = backgroundSubagents
    ? Array.from(backgroundSubagents.values()).some((j) => j.status === "running")
    : false
  const statusColor =
    info.status === "error"
      ? theme.error
      : info.status === "running"
        ? theme.warning
        : info.status === "thinking"
          ? theme.info
          : theme.success

  const activeSubagents = subagentTabs ? subagentTabs.filter((s) => s.status === "running" || s.status === "error") : []

  // Pure fit against real terminal columns: core always kept, optionals
  // added while they fit, model ellipsized rather than wrapped, hints
  // shortened then dropped. Nothing in here can emit a line wider than
  // `fit.inner` except absurd sub-minimum terminals (truncate net below).
  const fit = fitFooter({
    columns,
    model: info.model,
    statusText: STATUS_LABELS[info.status],
    modeText: `Mode: ${modeLabel}`,
    tokenText: `Tokens: ${tokenCount}`,
    ctxText: usage.percent !== null ? `ctx ${usage.percent}%` : undefined,
    bgText: bgCount > 0 ? `BG: ${bgCount}` : undefined,
    queueText: queuedCount > 0 ? `⛓ Queue: ${queuedCount}` : undefined,
    spinner: bgRunning || undefined,
    bgHint: bgCount > 0 ? "ctrl+b bg" : undefined,
    taskHint: info.taskHint,
    subagentLabels: activeSubagents.map((s) => `${subagentStatusIcon(s.status)} ${subagentLabel(s)}`),
    hintVariants: hintVariants(queuedCount),
  })

  const renderSegment = (seg: FooterSegment, index: number): ReactNode => {
    const separator = index > 0 ? <Text>{" ".repeat(SEGMENT_GAP)}</Text> : null
    let content: ReactNode
    switch (true) {
      case seg.id === "status": {
        // seg.text is "● <label>" — dot AND label take the status color
        // (identical widths: 1 + 1 + label). The old hardcoded green dot
        // claimed all-clear while the label said error/thinking.
        const label = seg.text.slice(2)
        content = (
          <>
            <Text color={statusColor}>{"● "}</Text>
            <Text color={statusColor}>{label}</Text>
          </>
        )
        break
      }
      case seg.id === "mode":
        content = <Text color={theme.primary}>{seg.text}</Text>
        break
      case seg.id === "tokens":
        content = <Text color={tokenColor}>{seg.text}</Text>
        break
      case seg.id === "ctx":
        content = <Text color={ctxColor}>{seg.text}</Text>
        break
      case seg.id === "bg":
        content = <Text color={theme.warning}>{seg.text}</Text>
        break
      case seg.id === "queue":
        content = <Text color={theme.info}>{seg.text}</Text>
        break
      case seg.id === "spinner":
        content = <Spinner color={theme.warning} />
        break
      case seg.id === "bg-hint":
        content = <Text dimColor>{seg.text}</Text>
        break
      case seg.id === "task-hint":
        content = <Text color={theme.success}>{seg.text}</Text>
        break
      case seg.id === "hints":
        content = <Text dimColor>{seg.text}</Text>
        break
      case seg.id.startsWith("chip:"): {
        const idx = Number(seg.id.slice(5))
        const item = activeSubagents[idx]
        const running = item?.status === "running"
        const icon = seg.text[0] ?? "●"
        const rest = seg.text.slice(1)
        content = running ? (
          <>
            <Spinner
              color={item ? subagentStatusColor(theme, item.status) : theme.warning}
              frames={["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]}
              cycleColors
            />
            <Text color={theme.textMuted}>{rest}</Text>
          </>
        ) : (
          <>
            <Text color={item ? subagentStatusColor(theme, item.status) : theme.textMuted}>{icon}</Text>
            <Text color={theme.textMuted}>{rest}</Text>
          </>
        )
        break
      }
      default:
        content = <Text dimColor>{seg.text}</Text>
    }
    return (
      <React.Fragment key={seg.id}>
        {separator}
        {content}
      </React.Fragment>
    )
  }

  // "Ye section bhi rounded" + "upar bhi ek line add": the status row is a
  // COMPLETE rounded panel — ╭--╮ on top, │ walls, ╰--╯ bottom (which
  // REPLACES the old plain --- rule). That's exactly the "footer(~3)" rows
  // MessageList's rowBudget already budgets (root border 2 + footer 3 +
  // composer 2 — 7) — so the frame still fills the viewport to the ↑ cap
  // with no overflow. Idle keeps the rule's always-blue azure (theme
  // switches must not dim it); while a turn runs the border animates with
  // the tool boxes ("that animation also [on] the model box").
  const animating = info.status === "running" || info.status === "thinking" || info.isStreaming === true
  const pulse = useBorderPulse(animating, [theme.primary, theme.accent, theme.warning, theme.success], theme.border)

  return (
    <Box flexDirection="column" flexShrink={0} borderStyle="round" borderColor={animating ? pulse.color : "#2EA6FF"}>
      <Box width="100%" paddingX={1}>
        {/* truncate is the last-resort net: fit math keeps us inside the
            box, this guarantees no mid-word split even at sub-minimum
            widths where core alone overflows. */}
        <Text color={theme.textMuted} wrap="truncate">
          {fit.model}
        </Text>
        <Box flexGrow={1} />
        <Box flexDirection="row">{fit.segments.map((seg, index) => renderSegment(seg, index))}</Box>
      </Box>
    </Box>
  )
}

export default Footer
