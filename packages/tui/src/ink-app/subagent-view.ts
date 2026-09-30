/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Pure view logic for subagent ("task") cards, the subagents panel, and the
 * agent picker. Kept free of React/ink so it can be unit-tested directly —
 * this is the port of SKT AI LABS's task-part rendering (formatSubagentTitle,
 * CompletedSubagentDetail, task list / inspector) into Ink's flat transcript.
 */

import type { TaggedAgentEvent } from "../../../protocol/src/index.js"
import type { TrayambakMessage, BackgroundSubagentState } from "./types.js"
import { formatSubagentTitle } from "./types.js"

export interface SubagentCardStart {
  subagentId: string
  name: string
  prompt: string
  subagentType?: string
  isolation?: string
  background: boolean
}

export function subagentCardId(subagentId: string, background: boolean): string {
  return background ? `subagent-bg-${subagentId}` : `subagent-${subagentId}`
}

/** Build the transcript card for a subagent lifecycle start. The title uses
 * SKT AI LABS's format ("<agent> Task[(background)] — <description>") with the
 * description flattened and capped at 60 chars. */
export function createSubagentCard(start: SubagentCardStart, now: number = Date.now()): TrayambakMessage {
  const flattened = start.prompt.replace(/\s+/g, " ").trim()
  const desc = flattened.length > 60 ? `${flattened.slice(0, 60)}…` : flattened || "(no prompt)"
  return {
    id: subagentCardId(start.subagentId, start.background),
    timestamp: now,
    role: "system",
    content: formatSubagentTitle(start.subagentType ?? "Agent", desc, start.background),
    subagentId: start.subagentId,
    subagentName: start.name,
    subagentType: start.subagentType,
    subagentIsolation: start.isolation,
    subagentBackground: start.background,
    subagentState: "running",
    subagentToolCalls: 0,
    subagentPrompt: start.prompt,
  }
}

export interface SubagentOutcome {
  state: "completed" | "error"
  detail: string
}

/** Mark a card finished — status, result/error text, and wall duration. */
export function finalizeSubagentCard(
  message: TrayambakMessage,
  outcome: SubagentOutcome,
  now: number = Date.now(),
): TrayambakMessage {
  return {
    ...message,
    subagentState: outcome.state,
    subagentDetail: outcome.detail,
    subagentDurationMs: Math.max(0, now - message.timestamp),
    isError: outcome.state === "error",
  }
}

export interface SubagentRouting {
  messageId: string
  background: boolean
  toolCalls: number
  lastTool?: string
  // Owning session: completions arriving after /clear or newchat (stale
  // session) must not mutate the NEW transcript — finalize/route drop
  // entries whose sessionId no longer matches.
  sessionId?: string | null
}

/** Fold a tagged child-loop event into the routing entry. Only tool starts
 * change the entry (count + last tool); everything else is a no-op (null) —
 * the emit-level guard has already kept those events out of the parent
 * transcript. */
export function applyChildToolEvent(routing: SubagentRouting, event: TaggedAgentEvent): SubagentRouting | null {
  if (event.type === "tool_execution_start") {
    return { ...routing, toolCalls: routing.toolCalls + 1, lastTool: event.toolName }
  }
  return null
}

export interface SubagentPanelRow {
  id: string
  source: "foreground" | "background"
  title: string
  status: "running" | "completed" | "error" | "cancelled"
  prompt?: string
  detail?: string
  error?: string
  toolCalls: number
  lastTool?: string
  isolation?: string
  subagentType?: string
  startedAt: number
  completedAt?: number
  durationMs: number
}

const STATUS_RANK: Record<SubagentPanelRow["status"], number> = {
  running: 0,
  error: 1,
  cancelled: 2,
  completed: 3,
}

/** Merge foreground transcript cards with the background job map into the
 * panel's row list: running first, then errors, then finished (newest first
 * inside each band). Background cards are excluded — the job map is the live
 * source of truth for background tasks (it carries prompt + result). */
export function buildSubagentRows(
  cards: TrayambakMessage[],
  background: BackgroundSubagentState[],
  now: number = Date.now(),
): SubagentPanelRow[] {
  const rows: SubagentPanelRow[] = []
  for (const card of cards) {
    if (!card.subagentId || card.subagentBackground) continue
    rows.push({
      id: card.subagentId,
      source: "foreground",
      title: card.content,
      status: card.subagentState ?? "running",
      prompt: card.subagentPrompt,
      detail: card.subagentState === "completed" ? card.subagentDetail : undefined,
      error: card.subagentState === "error" ? card.subagentDetail : undefined,
      toolCalls: card.subagentToolCalls ?? 0,
      lastTool: card.subagentLastTool,
      isolation: card.subagentIsolation,
      subagentType: card.subagentType,
      startedAt: card.timestamp,
      durationMs: card.subagentDurationMs ?? Math.max(0, now - card.timestamp),
    })
  }
  for (const job of background) {
    rows.push({
      id: job.id,
      source: "background",
      title: job.name,
      status: job.status,
      prompt: job.prompt,
      detail: job.result,
      error: job.error,
      toolCalls: job.toolcalls ?? 0,
      isolation: job.isolation,
      subagentType: job.subagentType,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      durationMs: (job.completedAt ?? now) - job.startedAt,
    })
  }
  return rows.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.startedAt - a.startedAt)
}

export interface AgentOption {
  value: string
  label: string
  category: string
  description: string
  builtin: boolean
}

/** The subagent types the trayambak__Agent tool schema accepts (its enum). */
export const BUILTIN_AGENT_OPTIONS: AgentOption[] = [
  {
    value: "general",
    label: "General",
    category: "builtin",
    description: "General-purpose agent for mixed tasks",
    builtin: true,
  },
  {
    value: "explore",
    label: "Explore",
    category: "builtin",
    description: "Fast read-only search and codebase exploration",
    builtin: true,
  },
  {
    value: "plan",
    label: "Plan",
    category: "builtin",
    description: "Designs implementation plans without editing files",
    builtin: true,
  },
  {
    value: "coder",
    label: "Coder",
    category: "builtin",
    description: "Writes, edits, and refactors code",
    builtin: true,
  },
  {
    value: "browser",
    label: "Browser",
    category: "builtin",
    description: "Drives a browser for web tasks",
    builtin: true,
  },
  {
    value: "planner",
    label: "Planner",
    category: "builtin",
    description: "Step-by-step research and task breakdown",
    builtin: true,
  },
]

/**
 * Builtins first, then discovered profiles. A profile whose name collides
 * with an existing entry (case-insensitive) replaces it, so duplicates
 * collapse into one row. The submitted `value` is always the profile NAME
 * because getAgentProfile() resolves by name, not by file path.
 */
export function mergeAgentOptions(
  discovered: Array<{ id: string; name: string; category: string; description: string }>,
): AgentOption[] {
  const merged: AgentOption[] = BUILTIN_AGENT_OPTIONS.map((option) => ({ ...option }))
  for (const profile of discovered) {
    const option: AgentOption = {
      value: profile.name,
      label: profile.name,
      category: profile.category,
      description: profile.description || `Custom agent profile (${profile.id})`,
      builtin: false,
    }
    const existing = merged.findIndex((candidate) => candidate.value.toLowerCase() === option.value.toLowerCase())
    if (existing >= 0) merged[existing] = option
    else merged.push(option)
  }
  return merged
}
