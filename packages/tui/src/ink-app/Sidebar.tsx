/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import React, { type ReactNode } from "react"
import { Box, Text } from "ink"
import { useThemeColors } from "./themeColors.js"
import { buildMcpRows, capItems, contextUsage, formatTodoLine, hasOpenTodos, type SidebarTodo } from "./sidebar-data.js"

/** Row caps keep the fixed-width pane from pushing the layout past a short
 * terminal (the sidebar has no scroll region in Ink). */
const MAX_MCP_ROWS = 8
const MAX_TODO_ROWS = 6

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
  /** SKT AI LABS's sidebar_title slot: session title. */
  title: string
  /** Workspace label under the title (SKT AI LABS's WorkspaceLabel slot). */
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

/** Port of SKT AI LABS's session sidebar (width 42, panel background, title /
 * content / footer slots) with trayambak's own data sources: Context
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
  const mcp = buildMcpRows(mcpServers)
  const mcpCap = capItems(mcp, MAX_MCP_ROWS)
  // SKT AI LABS shows the Todo section only while something is still open.
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
      {/* sidebar_title slot — session title + workspace (SKT AI LABS). Truncate,
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

      {/* sidebar_content — Context (SKT AI LABS slot order 100) */}
      <Box flexDirection="column" marginBottom={1}>
        <SectionHeader label="Context" />
        <Text dimColor>{`${usage.tokens.toLocaleString("en-US")} tokens`}</Text>
        <Text dimColor>{usage.percent !== null ? `${usage.percent}% used` : "context window unknown"}</Text>
        <Text dimColor wrap="truncate-end">
          {model}
        </Text>
      </Box>

      {/* sidebar_content — MCP (SKT AI LABS slot order 200; hidden when empty) */}
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

      {/* sidebar_content — Todo (SKT AI LABS slot order 400; hidden when all done) */}
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

      {/* Push the footer to the bottom of the pane (SKT AI LABS layout). */}
      <Box flexGrow={1} />

      {/* sidebar_footer slot — product identity (SKT AI LABS: "• SKT AI LABS <version>") */}
      <Box flexDirection="row">
        <Text color={theme.success}>{"•"}</Text>
        <Text dimColor>{" trayambak"}</Text>
      </Box>
    </Box>
  )
}

export default Sidebar
