/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Subagents overlay — Shrijan's foreground-task list + background-task inspector
 * ported to Ink. Replaces the content pane while open (so MessageList's and
 * PromptInput's input handlers are unmounted, no key conflicts): tabs for
 * all/background, selectable rows with live elapsed time, and an expandable
 * detail view (prompt, isolation, toolcalls, result/error, id).
 *
 *   enter/SPACE/l  expand · ↑/↓ or j/k  move · 1-9  jump+expand
 *   tab  all ⇄ background · esc/q  close
 */

import React, { useState, type ReactNode } from "react"
import { Box, Text, useStdout } from "ink"
import { Spinner } from "./Spinner.js"
import { Shimmer } from "./Shimmer.js"
import type { NemoMessage, BackgroundSubagentState } from "./types.js"
import { buildSubagentRows, type SubagentPanelRow } from "./subagent-view.js"
import { useThemeColors } from "./themeColors.js"
import { stringWidth, sliceByWidth } from "./utils/stringWidth.js"
import { useTicker } from "./use-animation-clock.js"
import { formatDuration, formatElapsed } from "./duration-text.js"
import { isEnter } from "./keys.js"
import { useAppInput } from "./useAppInput.js"
import { g } from "./glyphs.js"

export interface SubagentPanelProps {
  cards: NemoMessage[]
  background: BackgroundSubagentState[]
  initialTab?: "all" | "background"
  onClose: () => void
  /** Cancel a running background job (X key). Absent = no cancel action. */
  onCancel?: (id: string) => void
}

const STATUS_ICON: Record<SubagentPanelRow["status"], string> = {
  running: g("spinnerDot"),
  completed: g("dot"),
  error: g("fail"),
  cancelled: g("ring"),
}

function statusColor(theme: ReturnType<typeof useThemeColors>, status: SubagentPanelRow["status"]): string {
  if (status === "running") return theme.warning
  if (status === "completed") return theme.success
  if (status === "error") return theme.error
  return theme.textMuted
}

export const SubagentPanel = ({
  cards,
  background,
  initialTab = "all",
  onClose,
  onCancel,
}: SubagentPanelProps): ReactNode => {
  const theme = useThemeColors()
  const { stdout } = useStdout()
  const [tab, setTab] = useState<"all" | "background">(initialTab)
  const [selected, setSelected] = useState(0)
  const [expanded, setExpanded] = useState(/*initial*/ false)

  const now = Date.now()
  const allRows = buildSubagentRows(cards, background, now)
  const rows = tab === "background" ? allRows.filter((r) => r.source === "background") : allRows
  const runningCount = allRows.filter((r) => r.status === "running").length
  // The tick is not read — subscribing to the shared clock IS what re-renders
  // the elapsed column below. Gated on activity: the old private 1s interval
  // repainted the panel every second with nothing running, and ran alongside
  // every other widget's own timer instead of with them. `useTicker` because an
  // elapsed column is a duration, not a decoration — motion `off` must not
  // freeze it.
  useTicker(1000, runningCount > 0)
  const safeIdx = Math.min(selected, Math.max(0, rows.length - 1))

  // Title budget: probed across 6 layout variants — a flexGrow title Box
  // NEVER shrinks in yoga here (definite width clips badges mid-word,
  // indefinite width wraps them to line 2), so the title is capped in code
  // instead. ~55 cols reserved for select + icon + badges + padding.
  const termCols = stdout.columns || 100
  const titleBudget = Math.max(20, termCols - 55)
  const shownTitle = (title: string): string =>
    stringWidth(title) > titleBudget ? `${sliceByWidth(title, titleBudget - 1)}…` : title

  const maxVisible = Math.max(3, Math.min(12, (stdout.rows || 30) - 14))
  const windowStart =
    rows.length <= maxVisible
      ? 0
      : Math.max(0, Math.min(safeIdx - Math.floor(maxVisible / 2), rows.length - maxVisible))
  const visible = rows.slice(windowStart, windowStart + maxVisible)
  const current: SubagentPanelRow | undefined = rows[safeIdx]

  useAppInput((input, key) => {
    if (key.escape || input === "q") {
      onClose()
      return
    }
    if (key.tab) {
      setTab((t) => (t === "all" ? "background" : "all"))
      setSelected(0)
      setExpanded(/*expanded*/ false)
      return
    }
    if (key.upArrow || input === "k") {
      setSelected(Math.max(0, safeIdx - 1))
      setExpanded(/*expanded*/ false)
      return
    }
    if (key.downArrow || input === "j") {
      setSelected(Math.min(rows.length - 1, safeIdx + 1))
      setExpanded(/*expanded*/ false)
      return
    }
    if (isEnter(input, key) || input === " " || input === "l") {
      if (current) setExpanded((e) => !e)
      return
    }
    if (input === "h") {
      setExpanded(/*expanded*/ false)
      return
    }
    // X cancels the selected RUNNING background job (foreground cards run
    // inside the main turn — abort those with Ctrl+D). Background jobs used
    // to be unabortable: nothing wired a signal into their loop.
    if ((input === "x" || input === "X") && onCancel) {
      const row = rows[safeIdx]
      if (row && row.source === "background" && row.status === "running") {
        onCancel(row.id)
      }
      return
    }
    if (input && input >= "1" && input <= "9") {
      const idx = Math.min(rows.length - 1, parseInt(input, 10) - 1)
      if (idx >= 0) {
        setSelected(idx)
        setExpanded(/*expanded*/ true)
      }
    }
  })

  return (
    <Box flexDirection="column" height="100%" paddingX={1}>
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color={theme.primary}>
          Subagents
        </Text>
        <Text dimColor>
          {runningCount} running · {allRows.length} total · tab: {tab}
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {rows.length === 0 ? (
          <Text dimColor>
            No {tab === "background" ? "background " : ""}subagents yet — launch one with /agent run &lt;type&gt;
            &lt;prompt&gt; (add --bg to run it in the background).
          </Text>
        ) : (
          visible.map((row, idx) => {
            const realIdx = windowStart + idx
            const isSelected = realIdx === safeIdx
            return (
              // width 100%: the auto-width column would content-size the
              // nowrap title row (indefinite → truncate never fires, badges
              // wrap). Pinned to the rows column, the row distributes a
              // DEFINITE width and the title Box truncates.
              <Box key={`${row.source}-${row.id}`} flexDirection="column" width="100%">
                {/* nowrap + code-capped title: flexGrow-box truncation was
                    probed to never fire in this chain (definite clips
                    badges, indefinite wraps them) — shownTitle() bounds the
                    title deterministically, badges always fit line 1. */}
                <Box flexDirection="row" flexWrap="nowrap">
                  <Text bold={isSelected} color={isSelected ? theme.primary : undefined}>
                    {isSelected ? `${g("picker")} ` : "  "}
                  </Text>
                  {row.status === "running" ? (
                    <Spinner color={theme.warning} />
                  ) : (
                    <Text color={statusColor(theme, row.status)}>{STATUS_ICON[row.status]}</Text>
                  )}
                  {/* A running row shimmers its own title: with six agents in
                      flight the spinner column alone cannot tell you WHICH one
                      just moved. All rows read one clock, so they sweep in
                      phase instead of strobing out of step. */}
                  {row.status === "running" ? (
                    <Shimmer
                      text={` ${shownTitle(row.title)}`}
                      color={theme.text}
                      glow={theme.warning}
                      bold={isSelected}
                    />
                  ) : (
                    <Text bold={isSelected}> {shownTitle(row.title)}</Text>
                  )}
                  <Text color={theme.textMuted}> [{row.source}]</Text>
                  {row.subagentType && <Text color={theme.info}> {row.subagentType}</Text>}
                  {row.isolation === "worktree" && <Text color={theme.secondary}> ⎇ worktree</Text>}
                  <Text dimColor>
                    {" "}
                    {/* Live rows count up in whole seconds; finished rows are a
                        measurement — a 900ms subagent reading "0s" looks broken,
                        "900ms" reads as fast. */}
                    {row.status === "running" ? formatElapsed(row.durationMs) : formatDuration(row.durationMs)}
                  </Text>
                  {row.toolCalls > 0 && (
                    <Text dimColor>
                      {" "}
                      {row.toolCalls} toolcall{row.toolCalls === 1 ? "" : "s"}
                    </Text>
                  )}
                </Box>
                {isSelected && expanded && (
                  <Box flexDirection="column" marginLeft={4}>
                    {row.prompt && (
                      <Box flexDirection="column">
                        <Text dimColor>prompt:</Text>
                        <Text wrap="wrap">{row.prompt}</Text>
                      </Box>
                    )}
                    {row.lastTool && (
                      <Text dimColor wrap="truncate-end">
                        last tool: {row.lastTool}
                      </Text>
                    )}
                    {row.detail && (
                      <Box flexDirection="column">
                        <Text color={theme.success}>result:</Text>
                        <Text wrap="wrap" dimColor>
                          {row.detail.length > 3000 ? `${row.detail.slice(0, 3000)}…` : row.detail}
                        </Text>
                      </Box>
                    )}
                    {row.error && (
                      <Box flexDirection="column">
                        <Text color={theme.error}>error:</Text>
                        <Text wrap="wrap">{row.error}</Text>
                      </Box>
                    )}
                    <Text dimColor>id: {row.id}</Text>
                  </Box>
                )}
              </Box>
            )
          })
        )}
      </Box>

      <Box marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
        <Text dimColor wrap="truncate">
          {" enter/SPACE"} expand {" · ↑/↓ or j/k"} move {" · 1-9"} jump {" · tab"} all⇄bg
          {onCancel ? " · X cancel-bg" : ""} {" · esc/q"} close
        </Text>
      </Box>
    </Box>
  )
}

export default SubagentPanel
