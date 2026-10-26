/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { type ReactNode } from "react"
import { Box, Text } from "ink"
import type { ToolCallDisplay } from "./types.js"
import { useThemeColors } from "./themeColors.js"
import { cycleIndex } from "./animations.js"
import { useAnimationClock, useElapsed } from "./use-animation-clock.js"
import { formatElapsed } from "./duration-text.js"
import { sliceByWidth, stringWidth } from "./utils/stringWidth.js"
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
  // Cells, not UTF-16 units: `.length`/`.slice` counted a Devanagari matra or
  // an emoji ZWJ sequence as separate columns and cut one off its base.
  return stringWidth(flat) > 64 ? `${sliceByWidth(flat, 63)}…` : flat
}

export const SwarmToolCallItem = ({ toolCall, shouldAnimate = true }: SwarmToolCallItemProps): ReactNode => {
  const theme = useThemeColors()
  const summary = describeSwarmCall(toolCall.args ?? {})
  const isRunning = toolCall.status === "running"
  // Shared frame clock, not a private setInterval: several swarm/exec boxes live
  // at once used to each run their own 220ms timer, so every tick was a
  // separate partial repaint of the same transcript lines. The `active` gate
  // also means a finished swarm costs nothing.
  const tick = useAnimationClock(FRAME_INTERVAL_MS, shouldAnimate && isRunning)
  const elapsedMs = useElapsed(isRunning)

  if (!isRunning) {
    const failed = toolCall.status === "error" || toolCall.isError === true
    const head = sliceByWidth((toolCall.result ?? "").replace(/\s+/g, " ").trim(), 120)
    return (
      <Box flexDirection="column" marginTop={1} marginLeft={1}>
        <Text wrap="truncate-end">
          <Text color={failed ? theme.error : theme.success}>{failed ? g("fail") : g("ok")}</Text>
          <Text color={theme.primary} bold>
            {" "}
            nemo__Swarm ({summary.strategy})
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
  const workers = Math.max(1, Math.min(MAX_DOTS, summary.workerCount))
  const lit = cycleIndex(tick, workers)
  const dots = Array.from({ length: workers }, (_, i) => (i === lit ? g("dot") : g("ring"))).join(" ")

  return (
    <Box flexDirection="column" marginTop={1} marginLeft={1}>
      <Text wrap="truncate-end">
        <Text color={theme.warning} bold>
          {g("dot")}
        </Text>
        <Text color={theme.primary} bold>
          {" "}
          Nemo Swarm ({summary.strategy})
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
          {summary.workerCount} worker{summary.workerCount === 1 ? "" : "s"} running
          {/* The wall clock is the one number a fan-out makes the user want:
              eight dots chasing tells them it is alive, not how long it has
              been alive. */}
          {` • ${formatElapsed(elapsedMs)}`}
        </Text>
      </Box>
    </Box>
  )
}

export default SwarmToolCallItem
