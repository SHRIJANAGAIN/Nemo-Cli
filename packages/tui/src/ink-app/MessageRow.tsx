/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { type ReactNode } from "react"
import { Box, Text } from "ink"
import { ToolCallItem } from "./ToolCallItem.js"
import { Spinner } from "./Spinner.js"
import { SubagentRow } from "./SubagentRow.js"
import type { TrayambakMessage, ToolCallStatus, MessagePart, AppStatus } from "./types.js"
import { useThemeColors } from "./themeColors.js"
import { normalizeStairIndent } from "./text-format.js"

export interface MessageRowProps {
  message: TrayambakMessage
  verbose?: boolean
  isTranscriptMode?: boolean
  isStreaming?: boolean
  /** Turn phase: while "running" (text streaming) the reasoning spinner
   *  STANDS DOWN — reasoning finished, showing "Thinking…" above the
   *  growing answer was a lie ("AI GENERATE KR RHA HAI AUR THINKING
   *  DIKHA RAHA"). Undefined/other ? old behavior. */
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
    const shownContent =
      isCompactionMarker && !expandOutput ? content.split("\n")[0] + (content.includes("\n") ? " …" : "") : content
    return (
      <Box flexDirection="column" marginTop={1} marginLeft={1}>
        <Text color={theme.primary} bold>
          {"?"} {shownContent}
        </Text>
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
        {hasActiveThinking && isStreaming && phase !== "running" && (
          <Box flexDirection="row" marginLeft={2} marginTop={1}>
            <Spinner color={theme.warning}>Thinking…</Spinner>
          </Box>
        )}
        {message.parts && message.parts.length > 0 ? (
          <Box flexDirection="column" marginLeft={2}>
            {message.parts.map((part: MessagePart, idx: number) => {
              if (part.text) {
                return (
                  <Text key={`text-${idx}`} color={theme.markdownText}>
                    {normalizeStairIndent(part.text.text)}
                  </Text>
                )
              }
              if (part.thinking) {
                return (
                  <Box key={`thinking-${idx}`} flexDirection="column" marginTop={1}>
                    <Box flexDirection="row">
                      <Spinner color={theme.warning}>Thought</Spinner>
                    </Box>
                    <Box marginLeft={2}>
                      <Text color={theme.textMuted}>{normalizeStairIndent(part.thinking.text)}</Text>
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
            <Text color={theme.markdownText}>{normalizeStairIndent(message.content)}</Text>
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
          {message.isError ? "?" : "?"} {message.content}
        </Text>
      </Box>
    )
  }

  if (message.role === "tool") {
    const isError = message.isError ?? false
    const statusColor = isError ? theme.error : theme.success
    const statusIcon = isError ? "?" : "?"
    // SKT AI LABS port: tool results collapse to ONE line. A resumed session used
    // to dump every result's full JSON payload inline — walls of raw
    // interleave that buried the conversation under tool output.
    // Ctrl+O unfolds to full text (200-line cap, wrapped) instead.
    const raw = (message.content ?? "").replace(/\s+/g, " ").trim()
    const preview = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw
    // Ctrl+O: full text (20k-char cap with a marker past it) instead of
    // the one-line preview. Collapsed default is unchanged behavior.
    const shown = expandOutput ? raw.slice(0, 20000) : preview
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
              {shown}
              {overflowNote}
            </Text>
          ) : null}
        </Text>
      </Box>
    )
  }

  return null
}

export default MessageRow
