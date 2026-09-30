/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext } from "../types.js"
import { listWorktrees, type WorktreeEntry } from "./worktree.js"
import type { FleetJob } from "./fleet.js"

export interface AgentSessionRow {
  id: string
  name: string
  status: string
}

export interface AgentManagerDeps {
  onListSessions?: () => AgentSessionRow[]
  onListFleet?: () => FleetJob[]
}

export interface AgentSummary {
  sessionsActive: number
  sessionsTotal: number
  worktrees: number
  fleetRunning: number
  fleetDone: number
  fleetFailed: number
}

const MAX_SESSION_ROWS = 50
const MAX_WORKTREE_ROWS = 20
const MAX_FLEET_ROWS = 50
const MAX_OUTPUT_CHARS = 8000

export function truncateAgentName(name: string, max = 60): string {
  const clean = (name ?? "").replace(/\s+/g, " ").trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

export function summarizeAgents(
  sessions: AgentSessionRow[],
  worktrees: WorktreeEntry[],
  fleet: FleetJob[],
): AgentSummary {
  return {
    sessionsActive: sessions.filter((s) => s.status === "active").length,
    sessionsTotal: sessions.length,
    worktrees: worktrees.length,
    fleetRunning: fleet.filter((j) => j.status === "running").length,
    fleetDone: fleet.filter((j) => j.status === "completed").length,
    fleetFailed: fleet.filter((j) => j.status === "error" || j.status === "cancelled").length,
  }
}

export function formatAgentOverview(
  sessions: AgentSessionRow[],
  worktrees: WorktreeEntry[],
  fleet: FleetJob[],
  sessionsAvailable: boolean,
): string {
  const summary = summarizeAgents(sessions, worktrees, fleet)
  const parts: string[] = [
    `Agents: ${summary.sessionsTotal} sessions (${summary.sessionsActive} active), ` +
      `${summary.worktrees} worktrees, ${fleet.length} background jobs ` +
      `(${summary.fleetRunning} running / ${summary.fleetDone} done / ${summary.fleetFailed} needs input).`,
  ]
  if (sessionsAvailable && sessions.length === 0) {
    parts.push("Sessions: none saved yet.")
  } else if (sessions.length > 0) {
    const rows = sessions
      .slice(0, MAX_SESSION_ROWS)
      .map((s) => `- ${s.id} | ${truncateAgentName(s.name)} | ${s.status}`)
    parts.push(`Sessions:\n${rows.join("\n")}`)
    if (sessions.length > MAX_SESSION_ROWS) parts.push(`…and ${sessions.length - MAX_SESSION_ROWS} more sessions.`)
  } else {
    parts.push("Sessions: unavailable in this runtime (CLI session store lives outside the agent process).")
  }
  if (worktrees.length === 0) {
    parts.push("Worktrees: none (main checkout only).")
  } else {
    const rows = worktrees
      .slice(0, MAX_WORKTREE_ROWS)
      .map((w) => `- ${w.path} | ${w.branch || "(detached)"} | ${String(w.head || "").slice(0, 12)}`)
    parts.push(`Worktrees:\n${rows.join("\n")}`)
    if (worktrees.length > MAX_WORKTREE_ROWS) parts.push(`…and ${worktrees.length - MAX_WORKTREE_ROWS} more worktrees.`)
  }
  const running = fleet.filter((j) => j.status === "running")
  const done = fleet.filter((j) => j.status === "completed")
  const failed = fleet.filter((j) => j.status === "error" || j.status === "cancelled")
  const row = (j: FleetJob): string => `- ${j.id} | ${truncateAgentName(j.name)} | ${j.status}`
  if (fleet.length === 0) {
    parts.push("Background: no jobs. Dispatch one with trayambak__Agent (background: true).")
  } else {
    if (running.length > 0) parts.push(`Working:\n${running.slice(0, MAX_FLEET_ROWS).map(row).join("\n")}`)
    if (done.length > 0) parts.push(`Done:\n${done.slice(0, MAX_FLEET_ROWS).map(row).join("\n")}`)
    if (failed.length > 0) parts.push(`Needs input:\n${failed.slice(0, MAX_FLEET_ROWS).map(row).join("\n")}`)
  }
  const text = parts.join("\n\n")
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…(truncated)` : text
}

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "trayambak__AgentManager",
  description:
    "Unified agent overview: saved sessions, git worktrees for parallel work, and background subagent jobs grouped by state. Read-only; never spawns or kills agents.",
  parameters: {
    type: "object",
    required: ["action"],
    properties: {
      action: { type: "string", description: "list | summary", enum: ["list", "summary"] },
    },
  },
}

/** Read-only aggregator over sessions + worktrees + fleet. All lists are injected except worktrees (live `git worktree list` in `cwd`). */
export function createAgentManagerTool(deps?: AgentManagerDeps): Tool {
  return {
    definition,
    async execute(_id, args, _signal, _update, context) {
      const action = String(args.action ?? "")
      if (action !== "list" && action !== "summary") {
        return textResult("agent-manager: 'action' must be list | summary", /*isError*/ true)
      }
      const ctx = context as ToolContext | undefined
      let sessions: AgentSessionRow[] = []
      let sessionsAvailable = false
      if (deps?.onListSessions) {
        try {
          sessions = deps.onListSessions().slice(0, 500)
          sessionsAvailable = true
        } catch {
          sessions = []
          sessionsAvailable = false
        }
      }
      let worktrees: WorktreeEntry[] = []
      if (ctx?.cwd) {
        try {
          worktrees = await listWorktrees(ctx.cwd)
        } catch {
          worktrees = []
        }
      }
      let fleet: FleetJob[] = []
      if (deps?.onListFleet) {
        try {
          fleet = deps.onListFleet().slice(0, 200)
        } catch {
          fleet = []
        }
      }
      if (action === "summary") {
        const s = summarizeAgents(sessions, worktrees, fleet)
        return textResult(
          `Agents: ${s.sessionsTotal} sessions (${s.sessionsActive} active), ${s.worktrees} worktrees, ` +
            `${s.fleetRunning} running / ${s.fleetDone} done / ${s.fleetFailed} needs input background jobs.`,
        )
      }
      return textResult(formatAgentOverview(sessions, worktrees, fleet, sessionsAvailable))
    },
  }
}
