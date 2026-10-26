/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { type ReactNode } from "react"
import { Box, Text } from "ink"
import { ToolCallItem } from "./ToolCallItem.js"
import { MarkdownBlock } from "./Markdown.js"
import { Spinner } from "./Spinner.js"
import { ThinkingOrbs } from "./ThinkingOrbs.js"
import { SubagentRow } from "./SubagentRow.js"
import type { NemoMessage, ToolCallStatus, MessagePart, AppStatus } from "./types.js"
import { bubbleBackground, useThemeColors } from "./themeColors.js"
import { hardWrapLongRuns, normalizeStairIndent } from "./text-format.js"
import { g } from "./glyphs.js"

export interface MessageRowProps {
  message: NemoMessage
  verbose?: boolean
  isTranscriptMode?: boolean
  isStreaming?: boolean
  /** Turn phase: while "running" (text streaming) the reasoning spinner
   *  STANDS DOWN — reasoning finished, showing "Thinking…" above the
   *  growing answer was a lie ("AI GENERATE KR RHA HAI AUR THINKING
   *  DIKHA RAHA"). Undefined/other → old behavior. */
  phase?: AppStatus
  /** Ctrl+O: tool outputs + compaction markers render full instead of
   *  preview/collapsed. */
  expandOutput?: boolean
}

function parseToolArguments(argumentsValue: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof argumentsValue !== "string") return argumentsValue
  try {
    const parsed: unknown = JSON.parse(argumentsValue)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed }
  } catch {
    return { value: argumentsValue }
  }
}

export const MessageRow = ({
  message,
  isStreaming = false,
  phase,
  expandOutput = false,
}: MessageRowProps): ReactNode => {
  const theme = useThemeColors()

  // Subagent ("task") cards render as their own row kind — this must come
  // before the role switch (cards are role "system" and would otherwise spin).
  if (message.subagentId) {
    return <SubagentRow message={message} />
  }

  const thinkingText = message.thinking || ""
  const hasActiveThinking = thinkingText.length > 0
  if (message.role === "user") {
    // Ctrl+O collapses compaction summaries: the "[Context auto-compaction]
    // ..." marker folds to its first line (full text back on expand). Plain
    // prompts are untouched — only the marker prefix collapses.
    const content = message.content ?? ""
    const isCompactionMarker = content.startsWith("[Context auto-compaction]")
    const isInternalNudge = content.startsWith("[internal:nudge]")
    // Silent internal messages: auto-compaction markers & continuation nudges
    if (isCompactionMarker || isInternalNudge) {
      return null
    }
    const shownContent =
      isCompactionMarker && !expandOutput ? content.split("\n")[0] + (content.includes("\n") ? " …" : "") : content
    // Full-width user bubble (Codex-style): a panel-mixed-toward-text
    // block fills the whole row width behind plain text — no `❯` marker,
    // the block itself marks the turn. The accent edge runs the FULL box
    // height, barabar (padding lives on the outer box so the bar spans
    // text + breathing room alike). paddingY adds rows: the row budget
    // counts them (see estimateMessageRows), so nothing below gets clipped.
    // NO explicit width="100%": 100% + marginLeft overflows the parent's
    // content box by exactly the margin, so the bubble's backgroundColor
    // lands on the Static item box's right-border column and erases the │
    // (message-list-static contract). The parent column-stretches the
    // bubble to content−marginLeft instead — same full-width look, no
    // overflow into the border.
    return (
      <Box
        flexDirection="row"
        marginTop={1}
        marginLeft={1}
        paddingY={1}
        backgroundColor={bubbleBackground(theme.backgroundPanel, theme.text)}
      >
        <Box width={1} flexShrink={0} backgroundColor={theme.primary}>
          <Text> </Text>
        </Box>
        <Box paddingX={2} flexGrow={1}>
          <Text color={theme.text}>{shownContent}</Text>
        </Box>
      </Box>
    )
  }

  if (message.role === "assistant") {
    if (message.toolName && message.toolCallId) {
      const toolName: string = message.toolName
      const toolStatus = (message.toolStatus ?? "pending") as ToolCallStatus
      const shouldAnimate = toolStatus === "running"

      return (
        <Box flexDirection="column" marginTop={1} marginLeft={1}>
          <ToolCallItem
            toolCall={{
              id: message.toolCallId ?? message.id,
              name: toolName,
              args: message.content ? parseToolArguments(message.content) : {},
              status: toolStatus,
              result: message.result,
              isError: message.isError,
              durationMs: message.durationMs,
            }}
            shouldAnimate={shouldAnimate}
            shouldShowDot={true}
            addMargin={false}
            expandOutput={expandOutput}
          />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" marginTop={1} marginLeft={1}>
        {/* Codex-style shimmer: the tail of the transcript carries the status
            word itself shimmering while a turn streams; the footer's square
            is the app-wide one. One animated label per frame, never two. */}
        {hasActiveThinking && isStreaming && phase !== "running" && (
          <Box flexDirection="row" marginLeft={2} marginTop={1}>
            <ThinkingOrbs label="Thinking…" />
          </Box>
        )}
        {message.parts && message.parts.length > 0 ? (
          <Box flexDirection="column" marginLeft={2}>
            {message.parts.map((part: MessagePart, idx: number) => {
              if (part.text) {
                return (
                  <Box key={`text-${idx}`} flexDirection="column">
                    <MarkdownBlock text={hardWrapLongRuns(normalizeStairIndent(part.text.text))} />
                  </Box>
                )
              }
              if (part.thinking) {
                return (
                  <Box key={`thinking-${idx}`} flexDirection="column" marginTop={1}>
                    <Box flexDirection="row">
                      <Spinner color={theme.warning}>Thought</Spinner>
                    </Box>
                    <Box marginLeft={2}>
                      <Text color={theme.textMuted}>{hardWrapLongRuns(normalizeStairIndent(part.thinking.text))}</Text>
                    </Box>
                  </Box>
                )
              }
              if (part.toolCall) {
                return (
                  <ToolCallItem
                    key={`toolcall-${idx}`}
                    toolCall={{
                      id: part.toolCall.id,
                      name: part.toolCall.name,
                      args: parseToolArguments(part.toolCall.arguments),
                      status: "pending",
                    }}
                    expandOutput={expandOutput}
                  />
                )
              }
              return null
            })}
          </Box>
        ) : message.content ? (
          // column (not default row): a row-hugged Text measures/wraps
          // differently from the column-stretched parts-path Text above —
          // one-col wrap jumps between the two.
          <Box marginLeft={1} flexDirection="column">
            <MarkdownBlock text={hardWrapLongRuns(normalizeStairIndent(message.content))} />
          </Box>
        ) : null}
      </Box>
    )
  }

  if (message.role === "system") {
    // Static marker: system rows are durable transcript entries (banners,
    // answers, resumed-session notes). The old always-on animated spinner
    // rewrote its line forever — on a resumed history every banner spun at
    // once and churned Ink's frame writer into overlapping garbage.
    return (
      <Box flexDirection="column" marginTop={1} marginLeft={1}>
        <Text color={message.isError ? theme.error : theme.textMuted}>
          {message.isError ? g("fail") : g("ok")} {message.content}
        </Text>
      </Box>
    )
  }

  if (message.role === "tool") {
    const isError = message.isError ?? false
    const statusColor = isError ? theme.error : theme.success
    const statusIcon = isError ? g("fail") : g("ok")
    // Shrijan port: tool results collapse to ONE line. A resumed session used
    // to dump every result's full JSON payload inline — walls of raw
    // interleave that buried the conversation under tool output.
    // Ctrl+O unfolds to full text (200-line cap, wrapped) instead.
    const raw = (message.content ?? "").replace(/\s+/g, " ").trim()
    const preview = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw
    // Ctrl+O: full text (20k-char cap with a marker past it) instead of
    // the one-line preview. Collapsed default is unchanged behavior.
    // Unbroken runs are hard-wrapped first: yoga measures the displayed
    // string, and a 20k single-line measurement is what crashed the
    // renderer (wasm OOB) — wrapping only adds visual line breaks.
    const shown = hardWrapLongRuns(expandOutput ? raw.slice(0, 20000) : preview)
    const overflowNote =
      expandOutput && raw.length > shown.length ? ` … +${raw.length - shown.length} chars (truncated)` : ""

    return (
      <Box flexDirection="column" marginTop={1} marginLeft={1}>
        {/* ONE truncating text node: as 3 sibling flex rows the name could
            wrap to line 2 at 100–119 cols while the preview stayed on line 1
            ("Called bash" below its own arguments). Nested <Text> children
            share one line + truncate-end instead (same fix as ToolCallItem). */}
        <Text wrap="truncate-end">
          <Text color={statusColor}>{statusIcon}</Text>
          <Text color={theme.primary} bold>
            {" "}
            {message.toolName ?? "tool"}
          </Text>
          {preview ? (
            <Text color={theme.textMuted}>
              {" — "}
              {overflowNote}
              {/* Tool output is VERBATIM: no markdown parsing. Logs, diffs,
                  and code must reach the screen exactly as produced — an
                  italicized `*` or re-linked `[x](y)` in a log line is
                  rewritten data, not presentation. */}
              {shown}
            </Text>
          ) : null}
        </Text>
      </Box>
    )
  }

  return null
}

export default MessageRow
