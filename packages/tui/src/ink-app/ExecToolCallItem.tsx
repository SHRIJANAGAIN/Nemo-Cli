/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { type ReactNode } from "react"
import { Box, Text, useStdout } from "ink"
import { ToolUseLoader } from "./ToolUseLoader.js"
import type { ToolCallDisplay, ToolCallRenderMode } from "./types.js"
import { toolBoxWidth } from "./types.js"
import { highlightBashToLines, type BashPalette } from "./syntax-highlight.js"
import { useThemeColors, type ThemeSnapshot } from "./themeColors.js"
import { useBorderPulse } from "./use-border-pulse.js"
import { g } from "./glyphs.js"

/** Bind the active Ink theme's syntax tokens onto bash roles (/theme now
 *  recolors code blocks — the old hardcoded night-owl hues ignored it). */
function bashPalette(theme: ThemeSnapshot): BashPalette {
  return {
    keyword: theme.syntaxKeyword,
    builtin: theme.syntaxFunction,
    command: theme.syntaxType,
    string: theme.syntaxString,
    number: theme.syntaxNumber,
    comment: theme.syntaxComment,
  }
}

const TOOL_CALL_MAX_LINES = 5
const USER_SHELL_TOOL_CALL_MAX_LINES = 50

function formatUnifiedExecInteraction(command: string[], input?: string): string {
  const commandDisplay = command.join(" ")
  if (input && input.length > 0) {
    const preview = input.replace(/\n/g, "\\n").replace(/`/g, "\\`").slice(0, 80)
    return `Interacted with \`${commandDisplay}\`, sent \`${preview}\``
  }
  return `Waited for \`${commandDisplay}\``
}

export interface ExecToolCallItemProps {
  toolCall: ToolCallDisplay
  shouldAnimate?: boolean
  shouldShowDot?: boolean
  isTranscriptMode?: boolean
  addMargin?: boolean
  width?: number
  renderMode?: ToolCallRenderMode
  isUserShell?: boolean
  interactionInput?: string
  /** Ctrl+O: full result (200-line cap) instead of the line-capped preview. */
  expandOutput?: boolean
}

export const ExecToolCallItem = ({
  toolCall,
  shouldAnimate = false,
  shouldShowDot = true,
  addMargin = false,
  width = 80,
  isUserShell = false,
  interactionInput,
  expandOutput = false,
}: ExecToolCallItemProps): ReactNode => {
  const { status, result, isError, durationMs, command } = toolCall
  const theme = useThemeColors()
  // Real terminal width (was: stale `width` prop defaulting to 80, so exec
  // results were sliced at ~72 chars on every terminal).
  const { stdout } = useStdout()
  const termWidth = stdout?.columns ?? width
  const isFinished = status === "completed" || status === "error"
  const isQueued = status === "pending"
  const isRunning = status === "running"
  // Live border chase for running boxes (see use-border-pulse.ts): the
  // light trips around the edges every 160ms.
  const pulse = useBorderPulse(isRunning, [theme.primary, theme.accent, theme.warning, theme.success], theme.border)

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
      bullet = <Text color={theme.textMuted}>{g("bullet")}</Text>
    }
  }

  let title = ""
  let cmdDisplay = ""
  if (isUserShell) {
    title = "You ran"
    cmdDisplay = command || ""
  } else if (interactionInput !== undefined) {
    title = ""
    cmdDisplay = formatUnifiedExecInteraction(command ? [command] : [], interactionInput)
  } else if (isRunning) {
    title = "Running"
    cmdDisplay = command || ""
  } else {
    title = "Ran"
    cmdDisplay = command || ""
  }

  const highlightedLines = highlightBashToLines(cmdDisplay, bashPalette(theme))
  const maxLines = isUserShell ? USER_SHELL_TOOL_CALL_MAX_LINES : TOOL_CALL_MAX_LINES

  function spanToTextProps(span: {
    children: string
    style?: { color?: string; fontWeight?: string | number; fontStyle?: string }
  }) {
    const style = span.style || {}
    const props: Record<string, unknown> = { children: span.children }
    if (style.color) props.color = style.color
    if (style.fontWeight === "bold" || style.fontWeight === 700) props.bold = true
    if (style.fontStyle === "italic") props.italic = true
    return props
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
        {/* Column, bounded (flexGrow + minWidth 0): the old row-in-row laid
            multi-line commands side-by-side on ONE visual line ("echo a"
            glued next to "+ echo b"), and the unbounded inner row meant
            truncate-end never fired — long commands stretched the border
            past the terminal and pushed ✓/duration off-screen. Each command
            line is now its own row; the status mark rides a row of its own
            so it can never be clipped by command text. */}
        <Box flexDirection="column" flexGrow={1} minWidth={0}>
          <Box flexDirection="row">
            {title && <Text bold>{title} </Text>}
            {highlightedLines.length > 0 ? (
              <Text wrap="truncate-end">
                {highlightedLines[0].spans.map((span, si) => (
                  <Text key={si} {...spanToTextProps(span)}>
                    {span.children}
                  </Text>
                ))}
              </Text>
            ) : null}
          </Box>
          {highlightedLines.slice(1, maxLines).map((line, i) => (
            <Box key={i + 1} flexDirection="row">
              <Text color={theme.textMuted}>{i + 1 === 1 ? "  + " : "    "}</Text>
              <Text wrap="truncate-end">
                {line.spans.map((span, si) => (
                  <Text key={si} {...spanToTextProps(span)}>
                    {span.children}
                  </Text>
                ))}
              </Text>
            </Box>
          ))}
          {highlightedLines.length > maxLines && (
            <Text color={theme.textMuted}>{"  └ … +" + (highlightedLines.length - maxLines) + " lines"}</Text>
          )}
          {/* Ported resultLine palette: ok green bold / fail red bold before
              the (dim) duration — on its own row, always visible. */}
          {isFinished && (
            <Text wrap="truncate-end">
              <Text bold color={isError ? theme.error : theme.success}>
                {isError ? g("fail") : g("ok")}
              </Text>
              {durationMs !== undefined && <Text color={theme.textMuted}> • {durationMs}ms</Text>}
            </Text>
          )}
        </Box>
      </Box>

      {result && (
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          {((): ReactNode[] => {
            const all = result.split("\n")
            const limit = expandOutput ? 200 : maxLines
            const shown = all.slice(0, limit)
            const rows = shown.map((line, i) => (
              <Text key={i} color={theme.textMuted} wrap="truncate-end">
                {i === 0 ? "  + " : "    "}
                {line.replace(/\r/g, "").slice(0, Math.max(10, termWidth - 8)) || " "}
              </Text>
            ))
            if (all.length > limit) {
              rows.push(
                <Text key="more" color={theme.textMuted}>
                  {expandOutput ? `… +${all.length - limit} more lines (still collapsed past 200)` : "…"}
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

export default ExecToolCallItem
