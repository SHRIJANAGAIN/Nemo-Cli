/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { type ReactNode } from "react"
import { Box, Text, useStdout } from "ink"
import { ToolUseLoader } from "./ToolUseLoader.js"
import type { ToolCallDisplay, ToolCallRenderMode } from "./types.js"
import { toolBoxWidth } from "./types.js"
import { useThemeColors } from "./themeColors.js"
import { stringWidth, sliceByWidth } from "./utils/stringWidth.js"
import { useBorderPulse } from "./use-border-pulse.js"
import { useElapsed } from "./use-animation-clock.js"
import { ProgressBar } from "./ProgressBar.js"
import { formatDuration, formatElapsed } from "./duration-text.js"
import { hiddenLinesLabel, previewOutput } from "./output-preview.js"
import { g } from "./glyphs.js"

const TOOL_CALL_MAX_LINES = 5
const MAX_ARG_LENGTH = 60

/** Sweep length for the running bar: a quarter of the box, clamped so it stays
 * legible at 60 cols and does not span a 240-col terminal whole. */
function sweepWidth(termWidth: number): number {
  return Math.max(8, Math.min(28, Math.floor(termWidth / 4)))
}

function formatArgs(args: Record<string, unknown>, maxLen: number = MAX_ARG_LENGTH): string {
  const entries = Object.entries(args)
  if (entries.length === 0) return "{}"
  const formatted = entries.map(([key, value]) => {
    let valStr: string
    if (typeof value === "string") {
      valStr = value
    } else if (value === null) {
      valStr = "null"
    } else if (value === undefined) {
      valStr = "undefined"
    } else {
      try {
        valStr = JSON.stringify(value)
      } catch {
        valStr = String(value)
      }
    }
    // Width- and cluster-safe: raw `.length`/`.slice` cut Devanagari matras
    // off their base, leaving a stray mark at the "…" (Hindi args rendered
    // broken in the tool-call row).
    if (stringWidth(valStr) > maxLen) {
      valStr = sliceByWidth(valStr, maxLen - 1) + "…"
    }
    return `${key}=${valStr}`
  })
  const result = formatted.join(" ")
  if (stringWidth(result) > maxLen) {
    return sliceByWidth(result, maxLen - 1) + "…"
  }
  return result
}

export interface MCPToolCallItemProps {
  toolCall: ToolCallDisplay
  shouldAnimate?: boolean
  shouldShowDot?: boolean
  isTranscriptMode?: boolean
  addMargin?: boolean
  width?: number
  renderMode?: ToolCallRenderMode
  /** Ctrl+O: full result (200-line cap) instead of the line-capped preview. */
  expandOutput?: boolean
}

export const MCPToolCallItem = ({
  toolCall,
  shouldAnimate = false,
  shouldShowDot = true,
  addMargin = false,
  width = 80,
  renderMode = "display",
  expandOutput = false,
}: MCPToolCallItemProps): ReactNode => {
  const { name, args, status, result, isError, durationMs, server } = toolCall
  const theme = useThemeColors()
  // Real terminal width (was: stale `width` prop defaulting to 80, so MCP
  // results were sliced at ~72 chars on every terminal).
  const { stdout } = useStdout()
  const termWidth = stdout?.columns ?? width
  const isFinished = status === "completed" || status === "error"
  const isQueued = status === "pending"
  const isRunning = status === "running"
  // Live border chase for running boxes (see use-border-pulse.ts): the
  // light trips around the edges every 160ms.
  const pulse = useBorderPulse(isRunning, [theme.primary, theme.accent, theme.warning, theme.success], theme.border)
  const elapsedMs = useElapsed(isRunning)

  const nodeRepl = server === "node_repl" && name === "js"
  const compact = nodeRepl && renderMode === "display"

  // Width-aware args budget (mirrors ToolCallItem): a fixed 60 chars let the
  // truncate eat the ✓/duration tail at ~100 cols. Reserve room for bullet +
  // labels + server.name + parens + mark + duration. Rendered from here, so the
  // budget cannot drift from what the header actually shows.
  const durationTail = durationMs !== undefined && isFinished ? ` • ${formatDuration(durationMs)}` : ""
  const argBudget = Math.max(20, Math.min(60, termWidth - (server?.length ?? 0) - name.length - 25 - durationTail.length))
  const argsStr = formatArgs(args, argBudget)
  const title = compact
    ? typeof args?.title === "string"
      ? args.title.split(" ").slice(0, 10).join(" ")
      : "node_repl.js"
    : `${server}.${name}`

  const success = isFinished ? !isError : undefined
  let bullet: ReactNode
  if (shouldShowDot) {
    if (isQueued) {
      bullet = <Text dimColor>{g("ring")}</Text>
    } else if (isRunning) {
      bullet = <ToolUseLoader shouldAnimate={shouldAnimate} isUnresolved={true} isError={false} status={status} />
    } else if (success === false) {
      bullet = (
        <Text color={theme.error} bold>
          {g("fail")}
        </Text>
      )
    } else if (success === true) {
      bullet = (
        <Text color={theme.success} bold>
          {g("ok")}
        </Text>
      )
    } else {
      bullet = <Text color={theme.textMuted}>•</Text>
    }
  }

  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      marginLeft={addMargin ? 1 : 0}
      width={toolBoxWidth(termWidth)}
      borderColor={isFinished ? (isError ? theme.error : theme.border) : isRunning ? pulse.color : theme.borderActive}
      // One lit edge trips around the box while running (chase), static
      // colour when finished — and round corners, matching the frame.
      borderTopColor={isRunning ? pulse.top : undefined}
      borderRightColor={isRunning ? pulse.right : undefined}
      borderBottomColor={isRunning ? pulse.bottom : undefined}
      borderLeftColor={isRunning ? pulse.left : undefined}
      borderStyle="round"
      backgroundColor={isError ? theme.errorBg : isFinished ? theme.successBg : theme.backgroundPanel}
    >
      <Box flexDirection="row" width="100%">
        {shouldShowDot && bullet && (
          <Box minWidth={2} marginRight={1}>
            {bullet}
          </Box>
        )}
        {/* ONE truncating text node — sibling rows let yoga drop labels to
            a second line whenever the header exceeded the box (narrow
            terminals); nested <Text> children share one line instead. */}
        <Text wrap="truncate-end">
          <Text bold>{isFinished ? "Called" : "Calling"}</Text>
          {compact ? (
            <Text color={theme.primary} bold>
              {" "}
              {title}
            </Text>
          ) : (
            <>
              <Text color={theme.primary} bold>
                {" "}
                {title}
              </Text>
              <Text color={theme.textMuted} dimColor>
                {"("}
                {argsStr}
                {")"}
              </Text>
            </>
          )}
          {/* Ported resultLine palette: ✓ green bold / ✗ red bold, from the
              glyph table so NEMO_GLYPHS=ascii gets v/x like every other
              mark in the UI. */}
          {isFinished && (
            <Text bold color={isError ? theme.error : theme.success}>
              {" "}
              {isError ? g("fail") : g("ok")}
            </Text>
          )}
          {durationTail !== "" && <Text color={theme.textMuted}>{durationTail}</Text>}
        </Text>
      </Box>

      {/* Running row: a window sweeping the track plus the wall clock, on the
          line the ✓/duration mark takes when the call finishes — an MCP call
          that hangs was indistinguishable from one that just started. */}
      {isRunning && (
        <Box flexDirection="row" flexWrap="nowrap" marginLeft={3}>
          <ProgressBar indeterminate width={sweepWidth(termWidth)} color={pulse.color} intervalMs={140} />
          <Text color={theme.textMuted}>{` ${formatElapsed(elapsedMs)}`}</Text>
        </Box>
      )}

      {result && (
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          {((): ReactNode[] => {
            // Head AND tail (see output-preview.ts): an MCP tool that fails at
            // the end of a long payload used to preview only its first 5 lines,
            // which is where the error never is.
            const total = expandOutput ? 200 : TOOL_CALL_MAX_LINES
            const headLines = Math.ceil(total / 2)
            const preview = previewOutput(result, {
              headLines,
              tailLines: total - headLines,
              headCols: Math.max(10, termWidth - 12),
              tailCols: Math.max(6, Math.floor((termWidth - 12) / 3)),
            })
            const rows: ReactNode[] = preview.lines.map((line, i) => (
              <Text key={`line-${i}`} color={theme.textMuted} wrap="truncate-end">
                {i === 0 ? "  + " : "    "}
                {line || " "}
              </Text>
            ))
            if (preview.hidden > 0) {
              rows.splice(
                headLines,
                0,
                <Text key="hidden" color={theme.textMuted}>
                  {`    ${hiddenLinesLabel(preview.hidden, /* expandable */ !expandOutput)}`}
                </Text>,
              )
            }
            if (expandOutput && preview.hidden > 0) {
              rows.push(
                <Text key="cap" color={theme.textMuted}>
                  {"  (still collapsed past 200 lines)"}
                </Text>,
              )
            }
            if (isRunning && preview.partial) {
              rows.push(
                <Text key="stream" color={theme.textMuted}>
                  {"    ▌"}
                </Text>,
              )
            }
            return rows
          })()}
        </Box>
      )}
    </Box>
  )
}

export default MCPToolCallItem
