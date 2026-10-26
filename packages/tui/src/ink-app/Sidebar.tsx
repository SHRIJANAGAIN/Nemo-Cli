/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { type ReactNode } from "react"
import { Box, Text } from "ink"
import { useThemeColors, type ThemeSnapshot } from "./themeColors.js"
import { buildMcpRows, capItems, contextUsage, formatTodoLine, hasOpenTodos, type SidebarTodo } from "./sidebar-data.js"
import { colorRamp } from "./animations.js"
import { ProgressBar } from "./ProgressBar.js"
import { CountUp } from "./CountUp.js"
import { Marquee } from "./Marquee.js"
import { useCountUp } from "./use-animation-clock.js"

/** Row caps keep the fixed-width pane from pushing the layout past a short
 * terminal (the sidebar has no scroll region in Ink). */
const MAX_MCP_ROWS = 8
const MAX_TODO_ROWS = 6

/** The 42-cell pane minus both 2-cell padding gutters. */
const PANE_TEXT_COLS = 38
/** ... minus the cells the percent readout sits in beside the bar. */
const CONTEXT_BAR_COLS = 33

/**
 * Minimum terminal width for the fixed 42-col pane. Below it the pane
 * (flexShrink={0}) squeezes the transcript into unreadable wrapped slivers
 * beside a dark strip (observed live: 2-char fragments with the panel
 * background hogging the frame) — so the pane stands down and the chat
 * takes the full width instead.
 */
export const SIDEBAR_MIN_COLS = 90

/** Whether the sidebar may render: open AND enough room to share. */
export function shouldShowSidebar(open: boolean, columns: number | undefined): boolean {
  return open && (columns ?? 80) >= SIDEBAR_MIN_COLS
}

export interface SidebarProps {
  /** Shrijan's sidebar_title slot: session title. */
  title: string
  /** Workspace label under the title (Shrijan's WorkspaceLabel slot). */
  workspace: string
  tokenCount: number
  contextWindow?: number
  model: string
  mcpServers?: Record<string, { command?: string[]; url?: string }>
  todos: SidebarTodo[]
}

function SectionHeader({ label, hint }: { label: string; hint?: string }): ReactNode {
  return (
    <Box flexDirection="row">
      <Text bold>{label}</Text>
      {hint ? <Text dimColor>{` ${hint}`}</Text> : null}
    </Box>
  )
}

/** The bar is the glanceable read and the percent is the precise one, so the
 *  fill changes hue well before the window is actually full. The hue travels
 *  with the fraction instead of snapping at a threshold, because the animated
 *  bar reaches 0.7 gradually — a hard cut at the boundary reads as a flicker. */
function pressureColor(theme: ThemeSnapshot, fraction: number): string {
  return colorRamp([theme.success, theme.warning, theme.error], fraction * fraction)
}

/** Port of Shrijan's session sidebar (width 42, panel background, title /
 * content / footer slots) with nemo's own data sources: Context
 * (tokens + % of the model's window), MCP servers from config, and the
 * session's todos in the `/todo list` format. */
export function Sidebar({
  title,
  workspace,
  tokenCount,
  contextWindow,
  model,
  mcpServers,
  todos,
}: SidebarProps): ReactNode {
  const theme = useThemeColors()
  const usage = contextUsage(tokenCount, contextWindow)
  // A compaction or a large paste moves context in one step; easing the bar
  // across that gap is what makes it read as a change rather than a glitch.
  const fraction = usage.usableFraction ?? (usage.percent === null ? 0 : usage.percent / 100)
  const shownFraction = useCountUp(fraction, { precision: 4 })
  const mcp = buildMcpRows(mcpServers)
  const mcpCap = capItems(mcp, MAX_MCP_ROWS)
  // Shrijan shows the Todo section only while something is still open.
  const visibleTodos = hasOpenTodos(todos) ? todos : []
  const todoCap = capItems(visibleTodos, MAX_TODO_ROWS)
  const openCount = visibleTodos.filter((todo) => todo.status !== "completed").length

  return (
    <Box
      width={42}
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      flexShrink={0}
      overflow="hidden"
      backgroundColor={theme.backgroundPanel}
    >
      {/* sidebar_title slot — session title + workspace (Shrijan). Truncate,
          never wrap: the pane is a fixed 42 cols and has no scroll region,
          so a long path/model wrapping to 2–3 lines pushes the footer off
          the fixed-height frame. */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={theme.text} wrap="truncate-end">
          {title}
        </Text>
        <Text dimColor wrap="truncate-end">
          {workspace}
        </Text>
      </Box>

      {/* sidebar_content — Context (Shrijan slot order 100) */}
      <Box flexDirection="column" marginBottom={1}>
        <SectionHeader label="Context" />
        <Box flexDirection="row" flexWrap="nowrap">
          <ProgressBar value={shownFraction} width={CONTEXT_BAR_COLS} color={pressureColor(theme, shownFraction)} />
          <Text dimColor>{usage.percent === null ? " —" : ` ${usage.percent}%`}</Text>
        </Box>
        <Text dimColor>
          <CountUp value={usage.tokens} /> tokens
        </Text>
        {usage.percent === null ? <Text dimColor>{"context window unknown"}</Text> : null}
        {/* The model id is the one line long enough to be cut: it scrolls instead
            of truncating, because "gpt-4.1-2025…" tells you nothing. */}
        <Marquee text={model} width={PANE_TEXT_COLS} dimColor />
      </Box>

      {/* sidebar_content — MCP (Shrijan slot order 200; hidden when empty) */}
      {mcp.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          <SectionHeader label="MCP" hint={`(${mcp.length})`} />
          {mcpCap.shown.map((row) => (
            <Box key={row.name} flexDirection="row" flexWrap="nowrap">
              <Text color={theme.success}>{"• "}</Text>
              <Text wrap="truncate-end">{row.name} </Text>
              <Text dimColor>{row.transport}</Text>
            </Box>
          ))}
          {mcpCap.hidden > 0 ? <Text dimColor>{`  +${mcpCap.hidden} more`}</Text> : null}
        </Box>
      ) : null}

      {/* sidebar_content — Todo (Shrijan slot order 400; hidden when all done) */}
      {visibleTodos.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          <SectionHeader label="Todo" hint={`(${openCount}/${visibleTodos.length})`} />
          {todoCap.shown.map((todo) => (
            <Text key={todo.id} dimColor={todo.status === "completed"} wrap="truncate-end">
              {formatTodoLine(todo)}
            </Text>
          ))}
          {todoCap.hidden > 0 ? <Text dimColor>{`  +${todoCap.hidden} more`}</Text> : null}
        </Box>
      ) : null}

      {/* Push the footer to the bottom of the pane (Shrijan layout). */}
      <Box flexGrow={1} />

      {/* sidebar_footer slot — product identity (Shrijan: "• Shrijan <version>") */}
      <Box flexDirection="row">
        <Text color={theme.success}>{"•"}</Text>
        <Text dimColor>{" nemo"}</Text>
      </Box>
    </Box>
  )
}

export default Sidebar
