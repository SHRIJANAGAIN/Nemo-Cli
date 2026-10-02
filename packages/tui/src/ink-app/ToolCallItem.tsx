/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import React, { type ReactNode } from "react"
import { Box, Text, useStdout } from "ink"
import { ToolUseLoader } from "./ToolUseLoader.js"
import { MarkdownInline } from "./Markdown.js"
import { MCPToolCallItem } from "./MCPToolCallItem.js"
import { ExecToolCallItem } from "./ExecToolCallItem.js"
import { SwarmToolCallItem } from "./SwarmToolCallItem.js"
import type { ToolCallDisplay, ToolCallRenderMode } from "./types.js"
import { toolBoxWidth } from "./types.js"
import { truncateMiddleLines } from "../../../../apps/runtime/src/tools/text/diff-render.js"
import { useThemeColors } from "./themeColors.js"
import { useBorderPulse } from "./use-border-pulse.js"
import { g } from "./glyphs.js"

export interface ToolCallItemProps {
  toolCall: ToolCallDisplay
  shouldAnimate?: boolean
  shouldShowDot?: boolean
  isTranscriptMode?: boolean
  addMargin?: boolean
  width?: number
  renderMode?: ToolCallRenderMode
  /** Ctrl+O: result preview becomes full text (200-line cap) instead of
   *  head+tail. Drilled from App via MessageList/MessageRow. */
  expandOutput?: boolean
}

function isMCPToolCall(toolCall: ToolCallDisplay): boolean {
  return toolCall.toolType === "mcp" || !!toolCall.server
}

function isExecToolCall(toolCall: ToolCallDisplay): boolean {
  return toolCall.toolType === "exec" || !!toolCall.command
}

function isSwarmToolCall(toolCall: ToolCallDisplay): boolean {
  return toolCall.name === "skt__Swarm"
}

export const ToolCallItem = ({
  toolCall,
  shouldAnimate = false,
  shouldShowDot = true,
  isTranscriptMode = false,
  addMargin = false,
  width = 80,
  renderMode = "display",
  expandOutput = false,
}: ToolCallItemProps): ReactNode => {
  // Real terminal width: the width prop defaulted to 80 and MessageRow
  // never passed it, so result lines were pre-sliced for an 80-col
  // terminal no matter how wide the actual one was.
  const { stdout } = useStdout()
  const termWidth = stdout?.columns ?? width
  const theme = useThemeColors()
  // Live border chase ("animation bada do"): a RUNNING box trips a light
  // around its edges (top → right → bottom → left, palette colour per
  // step) every 160ms — bigger than the old flat colour swap. Called
  // before the MCP/exec dispatches so the hook count never depends on the
  // branch — but STAYS OFF when delegating (the inner item runs its own
  // chase; otherwise every MCP/exec row ran two intervals + double
  // renders).
  const delegated = isMCPToolCall(toolCall) || isExecToolCall(toolCall) || isSwarmToolCall(toolCall)
  const pulse = useBorderPulse(
    toolCall.status === "running" && !delegated,
    [theme.primary, theme.accent, theme.warning, theme.success],
    theme.border,
  )

  if (isMCPToolCall(toolCall)) {
    return (
      <MCPToolCallItem
        toolCall={toolCall}
        shouldAnimate={shouldAnimate}
        shouldShowDot={shouldShowDot}
        isTranscriptMode={isTranscriptMode}
        addMargin={addMargin}
        width={termWidth}
        renderMode={renderMode}
        expandOutput={expandOutput}
      />
    )
  }

  if (isSwarmToolCall(toolCall)) {
    return <SwarmToolCallItem toolCall={toolCall} shouldAnimate={shouldAnimate} />
  }

  if (isExecToolCall(toolCall)) {
    return (
      <ExecToolCallItem
        toolCall={toolCall}
        shouldAnimate={shouldAnimate}
        shouldShowDot={shouldShowDot}
        isTranscriptMode={isTranscriptMode}
        addMargin={addMargin}
        width={termWidth}
        renderMode={renderMode}
        expandOutput={expandOutput}
        isUserShell={toolCall.name === "Bash" || toolCall.name === "UserShell"}
        interactionInput={toolCall.args?.input as string | undefined}
      />
    )
  }

  const { name, args, status, result, isError, durationMs } = toolCall
  const isFinished = status === "completed" || status === "error"
  const isQueued = status === "pending"
  const isRunning = status === "running"

  let bullet: ReactNode
  if (shouldShowDot) {
    if (isQueued) {
      bullet = <Text dimColor>{g("ring")}</Text>
    } else if (isRunning) {
      bullet = <ToolUseLoader shouldAnimate={shouldAnimate} isUnresolved={true} isError={false} status={status} />
    } else if (isError) {
      bullet = (
        <Text color={theme.error} bold>
          {g("fail")}
        </Text>
      )
    } else {
      bullet = (
        <Text color={theme.success} bold>
          {g("ok")}
        </Text>
      )
    }
  }

  // No hover state: ink Box has no mouse events, so the old onMouseOver/Out
  // props never fired (hover was always false, backgroundMenu dead code).
  const backgroundColor = isError ? theme.errorBg : isFinished ? theme.successBg : theme.backgroundPanel

  // Budget the args slice so labels + ✓/duration fit the box at this
  // terminal width (box inner = termWidth-5, bullet row = 3 more; labels
  // up to "Calling bash" = 12, parens 2, mark 2). The single-Text
  // truncate-end below is the hard guarantee if the estimate is off.
  // A "…" marks the cut — the old bare slice ended headers mid-word
  // ("Explore the) with no sign anything was hidden.
  const durationTail = durationMs !== undefined && isFinished ? ` • ${durationMs}ms`.length : 0
  const argBudget = Math.max(20, Math.min(100, termWidth - 25 - durationTail))
  const argRaw = Object.keys(args).length > 0 ? JSON.stringify(args) : ""
  const argJson = argRaw.length > argBudget ? `${argRaw.slice(0, argBudget - 1)}…` : argRaw

  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      marginLeft={addMargin ? 1 : 0}
      width={toolBoxWidth(termWidth)}
      borderColor={isFinished ? (isError ? theme.error : theme.border) : isRunning ? pulse.color : theme.borderActive}
      // Chase: one lit edge (palette colour) trips around the box while
      // running; the other three sit dim. Finished boxes keep a static
      // colour — and every box is round (the conversation-box corners are
      // round too; a sharp ++ nested inside ?? looked half-styled).
      borderTopColor={isRunning ? pulse.top : undefined}
      borderRightColor={isRunning ? pulse.right : undefined}
      borderBottomColor={isRunning ? pulse.bottom : undefined}
      borderLeftColor={isRunning ? pulse.left : undefined}
      borderStyle="round"
      backgroundColor={backgroundColor}
    >
      <Box flexDirection="row" width="100%">
        {shouldShowDot && bullet && (
          <Box minWidth={2} marginRight={1}>
            {bullet}
          </Box>
        )}
        {/* ONE truncating text node for the whole header. As sibling flex
            rows, any header whose natural width exceeded the box (=119-col
            terminals with a 100-char args slice) made yoga push the
            shrink-free label boxes to a second line while args/✓ stayed on
            the first — "Called bash" rendered BELOW its own arguments.
            Nested <Text> children share one line + truncate-end instead. */}
        <Text wrap="truncate-end">
          <Text bold>{isFinished ? "Called" : "Calling"}</Text>
          <Text color={theme.primary} bold>
            {" "}
            {name}
          </Text>
          {argJson !== "" && (
            <Text color={theme.textMuted} dimColor>
              ({argJson})
            </Text>
          )}
          {/* Ported resultLine palette: ✓ green bold / ✗ red bold before
              the (dim) duration — completed calls carry a visible status. */}
          {isFinished && (
            <Text bold color={isError ? theme.error : theme.success}>
              {isError ? ` ${g("fail")}` : ` ${g("ok")}`}
            </Text>
          )}
          {durationMs !== undefined && isFinished && <Text color={theme.textMuted}> • {durationMs}ms</Text>}
        </Text>
      </Box>

      {result && (
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          {/* Preview lines WRAP (was: hard slice(width-8) + truncate-end —
              with width stuck at its 80 default every result line was
              silently cut at ~72 chars on any terminal: "response of
              assistant are cutting"). Each line is bounded to ~3 wrapped
              rows so one minified blob can't swallow the transcript
              budget; "…" marks the cut. Long output is head+tail
              (codex live_output port) — first-5-only hid the tail, which
              usually holds the verdict. */}
          {((): ReactNode[] => {
            const all = result.split("\n")
            // Ctrl+O unfolds to full text (200-line cap + marker past it);
            // collapsed default keeps the head+tail preview.
            const shown = expandOutput
              ? all.length > 200
                ? [...all.slice(0, 200), `… +${all.length - 200} more lines (still collapsed past 200)`]
                : all
              : all.length > 8
                ? truncateMiddleLines(all, 4, 3)
                : all.slice(0, 5)
            return shown.map((line, i) => {
              const clean = line.replace(/\r/g, "")
              const cap = Math.max(40, (termWidth - 12) * 3)
              const shownLine = clean.length > cap ? `${clean.slice(0, cap)}…` : clean
              return (
                <Text key={i}>
                  <Text color={theme.textMuted}>{i === 0 ? "  + " : "    "}</Text>
                  <MarkdownInline text={shownLine || " "} color={theme.textMuted} />
                </Text>
              )
            })
          })()}
          {result.split("\n").length > 5 && result.split("\n").length <= 8 && !expandOutput && (
            <Text color={theme.textMuted}>…</Text>
          )}
        </Box>
      )}
    </Box>
  )
}

export default ToolCallItem
