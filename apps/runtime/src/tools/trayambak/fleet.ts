/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool } from "../types.js"

export interface FleetJob {
  id: string
  name: string
  status: "running" | "completed" | "error" | "cancelled"
  startedAt: number
  output?: string
  error?: string
}

export type FleetLister = () => FleetJob[]

function groupJobs(jobs: FleetJob[]): { running: FleetJob[]; done: FleetJob[]; failed: FleetJob[] } {
  return {
    running: jobs.filter((j) => j.status === "running"),
    done: jobs.filter((j) => j.status === "completed"),
    failed: jobs.filter((j) => j.status === "error" || j.status === "cancelled"),
  }
}

export function fleetListText(jobs: FleetJob[]): string {
  if (jobs.length === 0) return "Fleet: no background sessions. Dispatch one with trayambak__Agent (background: true)."
  const g = groupJobs(jobs)
  const row = (j: FleetJob): string => `- ${j.id} | ${j.name.slice(0, 60)} | ${j.status} | started ${new Date(j.startedAt).toISOString()}`
  const parts = ["Fleet (this session only — jobs live in-process and do not survive restart):"]
  if (g.running.length > 0) parts.push(`Working:\n${g.running.map(row).join("\n")}`)
  if (g.done.length > 0) parts.push(`Done:\n${g.done.map(row).join("\n")}`)
  if (g.failed.length > 0) parts.push(`Needs input:\n${g.failed.map(row).join("\n")}`)
  return parts.join("\n\n")
}

export function fleetPeekText(jobs: FleetJob[], id: string): string {
  const job = jobs.find((j) => j.id === id || j.name === id)
  if (!job) return `Fleet: no job matches "${id}".`
  const body = (job.output ?? job.error ?? "(no output yet)").slice(-2000)
  return `Peek ${job.id} (${job.name}) [${job.status}]:\n${body}`
}

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "trayambak__Fleet",
  description:
    "Trayambak Fleet: list background subagent sessions in this process grouped by state (working/done/needs input), or peek at one's recent output without attaching. Jobs are in-process only.",
  parameters: {
    type: "object",
    required: ["action"],
    properties: {
      action: { type: "string", description: "list | peek", enum: ["list", "peek"] },
      id: { type: "string", description: "Job id or name (for peek)." },
    },
  },
}

export function createFleetTool(onListFleet?: FleetLister): Tool {
  return {
    definition,
    async execute(_id, args) {
      if (!onListFleet) return textResult("Fleet registry is unavailable in this runtime.", /*isError*/ true)
      const action = String(args.action ?? "")
      const jobs = onListFleet()
      if (action === "list") return textResult(fleetListText(jobs))
      if (action === "peek") {
        const id = String(args.id ?? "")
        if (!id) return textResult("Fleet peek needs 'id'.", /*isError*/ true)
        return textResult(fleetPeekText(jobs, id))
      }
      return textResult("fleet: 'action' must be list | peek", /*isError*/ true)
    },
  }
}
