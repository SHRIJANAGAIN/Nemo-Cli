/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import {
  createAgentManagerTool,
  formatAgentOverview,
  summarizeAgents,
  truncateAgentName,
  type AgentSessionRow,
} from "./agent-manager.js"
import type { FleetJob } from "./fleet.js"
import type { WorktreeEntry } from "./worktree.js"

function fleetJob(id: string, name: string, status: FleetJob["status"]): FleetJob {
  return { id, name, status, startedAt: 1700000000000 }
}

function worktree(entry: Partial<WorktreeEntry> & { path: string }): WorktreeEntry {
  return { branch: "main", head: "abc123def456", ...entry }
}

describe("agent-manager pure helpers", () => {
  it("truncates long names with an ellipsis", () => {
    expect(truncateAgentName("short")).toBe("short")
    expect(truncateAgentName("  spaced   out  ")).toBe("spaced out")
    expect(truncateAgentName("x".repeat(100)).length).toBeLessThanOrEqual(60)
  })

  it("summarizes sessions + worktrees + fleet", () => {
    const sessions: AgentSessionRow[] = [
      { id: "s1", name: "one", status: "active" },
      { id: "s2", name: "two", status: "completed" },
    ]
    const s = summarizeAgents(sessions, [worktree({ path: "/w" })], [fleetJob("j1", "a", "running")])
    expect(s).toEqual({
      sessionsActive: 1,
      sessionsTotal: 2,
      worktrees: 1,
      fleetRunning: 1,
      fleetDone: 0,
      fleetFailed: 0,
    })
  })

  it("formats an empty overview honestly", () => {
    const text = formatAgentOverview([], [], [], /*sessionsAvailable*/ true)
    expect(text).toContain("0 sessions")
    expect(text).toContain("Sessions: none saved yet.")
    expect(text).toContain("main checkout only")
    expect(text).toContain("no jobs")
  })

  it("marks sessions unavailable instead of inventing them", () => {
    const text = formatAgentOverview([], [], [], /*sessionsAvailable*/ false)
    expect(text).toContain("unavailable in this runtime")
  })

  it("caps rows and output length", () => {
    const sessions: AgentSessionRow[] = Array.from({ length: 80 }, (_, i) => ({
      id: `s${i}`,
      name: `session ${i}`,
      status: "active",
    }))
    const text = formatAgentOverview(sessions, [], [], /*sessionsAvailable*/ true)
    expect(text).toContain("…and 30 more sessions.")
    expect(text.length).toBeLessThanOrEqual(9000)
  })
})

describe("trayambak__AgentManager tool", () => {
  it("rejects unknown actions", async () => {
    const tool = createAgentManagerTool()
    const res = await tool.execute("id", { action: "nope" }, undefined, undefined, undefined)
    expect(res.isError).toBe(true)
  })

  it("summarizes injected sessions + fleet without cwd", async () => {
    const tool = createAgentManagerTool({
      onListSessions: () => [{ id: "s1", name: "one", status: "active" }],
      onListFleet: () => [fleetJob("j1", "job one", "running")],
    })
    const res = await tool.execute("id", { action: "summary" }, undefined, undefined, undefined)
    const text = res.content.find((c) => c.type === "text")
    expect(text && "text" in text ? text.text : "").toContain("1 sessions (1 active)")
  })

  it("lists with unavailable sessions note when no lister is wired", async () => {
    const tool = createAgentManagerTool()
    const res = await tool.execute("id", { action: "list" }, undefined, undefined, undefined)
    const text = res.content.find((c) => c.type === "text")
    expect(text && "text" in text ? text.text : "").toContain("unavailable in this runtime")
  })

  it("survives throwing listers", async () => {
    const tool = createAgentManagerTool({
      onListSessions: () => {
        throw new Error("store down")
      },
      onListFleet: () => {
        throw new Error("fleet down")
      },
    })
    const res = await tool.execute("id", { action: "list" }, undefined, undefined, undefined)
    expect(res.isError).toBeFalsy()
  })
})
