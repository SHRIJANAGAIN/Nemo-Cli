/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Transcript row for a subagent ("task") card — Shrijan's task part rendered as
 * one Ink row: title line with badges, a live status line (spinner while
 * running, toolcall counts, wall time), and the result/error when finished.
 */

import React, { type ReactNode } from "react"
import { Box, Text } from "ink"
import { Spinner } from "./Spinner.js"
import type { NemoMessage } from "./types.js"
import { formatSubagentToolcalls, formatCompletedSubagentDetail } from "./types.js"
import { useThemeColors } from "./themeColors.js"
import { useTicker } from "./use-animation-clock.js"
import { sliceByWidth } from "./utils/stringWidth.js"
import { g } from "./glyphs.js"

export interface SubagentRowProps {
  message: NemoMessage
}

const MAX_DETAIL_CHARS = 2000

export const SubagentRow = ({ message }: SubagentRowProps): ReactNode => {
  const theme = useThemeColors()
  const state = message.subagentState ?? "running"
  const background = message.subagentBackground === true
  const toolCalls = message.subagentToolCalls ?? 0

  // Live wall-time: without a tick `· Ns` froze at the first render while
  // running (the child Spinner's interval doesn't re-render THIS row), so the
  // card looked stuck despite spinning. Ticks on the SHARED clock, and only
  // while running — finished cards stay still (Static-safe) and pay for no
  // timer at all. `useTicker` rather than `useAnimationClock` because `Ns` is
  // a real duration: `NEMO_MOTION=off` may stop decoration, but it must
  // not leave a running card stuck at "0s".
  useTicker(1000, state === "running")

  const durationMs = message.subagentDurationMs ?? Math.max(0, Date.now() - message.timestamp)
  const sec = Math.floor(durationMs / 1000)

  const statusColor = state === "running" ? theme.warning : state === "completed" ? theme.success : theme.error
  const statusIcon = state === "completed" ? g("dot") : state === "error" ? g("fail") : ""

  const detail = (message.subagentDetail ?? "").trim()
  // Cells, not UTF-16 units: `.slice` split a combining mark from its base and
  // an emoji from its ZWJ, leaving a stray glyph at the cut.
  const shownDetail = detail.length > MAX_DETAIL_CHARS ? `${sliceByWidth(detail, MAX_DETAIL_CHARS)}…` : detail

  return (
    <Box flexDirection="column" marginTop={1} marginLeft={1}>
      {/* ONE truncating text node: 4 sibling Texts let the title wrap
          mid-line at 100 cols with badges orphaned on line 1. */}
      <Text wrap="truncate-end">
        <Text bold color={statusColor}>
          {state === "running" ? "◍ " : `${statusIcon} `}
        </Text>
        <Text bold color={theme.info}>
          {message.content}
        </Text>
        {background && <Text color={theme.textMuted}> (background)</Text>}
        {message.subagentIsolation === "worktree" && <Text color={theme.secondary}> ⎇ worktree</Text>}
      </Text>
      <Box marginLeft={2} flexDirection="row">
        {state === "running" ? (
          <Spinner color={theme.warning} />
        ) : (
          <Text color={statusColor}>{state === "completed" ? g("ok") : g("fail")}</Text>
        )}
        <Text color={statusColor}>
          {state === "running" ? " running" : state === "completed" ? " completed" : " failed"}
        </Text>
        {/* lastTool capped: an unbounded 100-char tool/command wrapped and
            pushed `· Ns` to an unindented line 2. */}
        <Text dimColor wrap="truncate-end">
          {state === "running"
            ? ` · ${formatSubagentToolcalls(toolCalls)}${message.subagentLastTool ? ` · last: ${message.subagentLastTool.slice(0, 40)}` : ""} · ${sec}s`
            : ` · ${formatCompletedSubagentDetail(toolCalls, `${sec}s`)}`}
        </Text>
      </Box>
      {shownDetail && (
        <Box marginLeft={2} flexDirection="column">
          <Text dimColor wrap="wrap">
            {shownDetail}
          </Text>
        </Box>
      )}
    </Box>
  )
}

export default SubagentRow
