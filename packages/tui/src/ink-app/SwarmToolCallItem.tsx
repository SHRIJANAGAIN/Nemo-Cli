/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import React, { type ReactNode, useEffect, useState } from "react"
import { Box, Text } from "ink"
import type { ToolCallDisplay } from "./types.js"
import { useThemeColors } from "./themeColors.js"
import { g } from "./glyphs.js"

export interface SwarmToolCallItemProps {
  toolCall: ToolCallDisplay
  shouldAnimate?: boolean
}

const FRAME_INTERVAL_MS = 220
const MAX_DOTS = 8

export interface SwarmCallSummary {
  goal: string
  strategy: string
  workerCount: number
}

/** Read the swarm's display facts out of raw tool args. Pure. */
export function describeSwarmCall(args: Record<string, unknown>): SwarmCallSummary {
  const goal = String(args.goal ?? "").trim()
  const rawStrategy = String(args.strategy ?? "fanout")
    .trim()
    .toLowerCase()
  const strategy = rawStrategy === "pipeline" || rawStrategy === "vote" ? rawStrategy : "fanout"
  if (strategy === "vote") {
    const raw = typeof args.workers === "number" && Number.isFinite(args.workers) ? Math.floor(args.workers) : 3
    return { goal, strategy, workerCount: Math.max(2, Math.min(7, raw)) }
  }
  const tasks = Array.isArray(args.tasks) ? args.tasks : []
  return { goal, strategy, workerCount: Math.min(8, tasks.length) }
}

function shortGoal(goal: string): string {
  const flat = goal.replace(/\s+/g, " ").trim()
  if (!flat) return "swarming"
  return flat.length > 64 ? `${flat.slice(0, 64)}…` : flat
}

export const SwarmToolCallItem = ({ toolCall, shouldAnimate = true }: SwarmToolCallItemProps): ReactNode => {
  const theme = useThemeColors()
  const summary = describeSwarmCall(toolCall.args ?? {})
  const isRunning = toolCall.status === "running"
  const [frame, setFrame] = useState(/*initial*/ 0)

  useEffect(() => {
    if (!shouldAnimate || !isRunning) return
    const interval = setInterval(() => {
      setFrame((f) => f + 1)
    }, FRAME_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [shouldAnimate, isRunning])

  if (!isRunning) {
    const failed = toolCall.status === "error" || toolCall.isError === true
    const head = (toolCall.result ?? "").replace(/\s+/g, " ").trim().slice(0, 120)
    return (
      <Box flexDirection="column" marginTop={1} marginLeft={1}>
        <Text wrap="truncate-end">
          <Text color={failed ? theme.error : theme.success}>{failed ? g("fail") : g("ok")}</Text>
          <Text color={theme.primary} bold>
            {" "}
            skt__Swarm ({summary.strategy})
          </Text>
          <Text color={theme.textMuted}>
            {" — "}
            {summary.workerCount} worker{summary.workerCount === 1 ? "" : "s"} heard
            {head ? ` — ${head}` : ""}
          </Text>
        </Text>
      </Box>
    )
  }

  // Worker chase: one lit dot orbits the row while the swarm runs. Dots are
  // width-stable (●/○ same cell) so the line never jitters between frames.
  const dots = Array.from({ length: Math.max(1, Math.min(MAX_DOTS, summary.workerCount)) }, (_, i) =>
    i === frame % Math.max(1, Math.min(MAX_DOTS, summary.workerCount)) ? g("dot") : g("ring"),
  ).join(" ")

  return (
    <Box flexDirection="column" marginTop={1} marginLeft={1}>
      <Text wrap="truncate-end">
        <Text color={theme.warning} bold>
          {g("dot")}
        </Text>
        <Text color={theme.primary} bold>
          {" "}
          SKT Swarm ({summary.strategy})
        </Text>
        <Text color={theme.textMuted}>
          {" — "}
          {shortGoal(summary.goal)}
        </Text>
      </Text>
      <Box marginLeft={2}>
        <Text color={theme.warning}>{dots}</Text>
        <Text color={theme.textMuted}>
          {"  "}
          {summary.workerCount} worker{summary.workerCount === 1 ? "" : "s"} running…
        </Text>
      </Box>
    </Box>
  )
}

export default SwarmToolCallItem
