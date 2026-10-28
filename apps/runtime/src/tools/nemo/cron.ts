/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool } from "../types.js"

interface CronJob {
  id: string
  cron: string
  prompt: string
  recurring: boolean
  createdAt: number
  nextFireAt: number
  lastFiredAt?: number
}

const jobs = new Map<string, CronJob>()
let idCounter = 0

function nextId(): string {
  return `cron_${Date.now().toString(36)}_${(++idCounter).toString(36)}`
}

function cronMatches(cron: string, now: Date): boolean {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const [min, hour, dom, mon, dow] = fields
  return (
    matchField(min, now.getMinutes()) &&
    matchField(hour, now.getHours()) &&
    matchField(dom, now.getDate()) &&
    matchField(mon, now.getMonth() + 1) &&
    matchField(dow, now.getDay())
  )
}

function matchField(field: string, value: number): boolean {
  if (field === "*") return true
  if (field.includes("/")) {
    const [base, step] = field.split("/")
    const start = base === "*" ? 0 : Number(base)
    return (value - start) % Number(step) === 0 && value >= start
  }
  if (field.includes(",")) {
    return field.split(",").map(Number).includes(value)
  }
  if (field.includes("-")) {
    const [start, end] = field.split("-").map(Number)
    return value >= start && value <= end
  }
  return Number(field) === value
}

function computeNextFire(cron: string, from: Date = new Date()): number {
  // Scan a full 4-year leap cycle minute-by-minute. The old 7-day horizon
  // missed rare-but-valid expressions (Feb 29, leap-year combos) and pulled
  // them to the +24h fallback — which then re-missed on every reschedule, so
  // the job fired EVERY DAY (the round-13 garbage-cron bug, in disguise, for
  // crons that pass validation). Impossible dates (Feb 30) fall out to a
  // far-future sentinel: they can never match, so they must never fire.
  const horizonMs = 4 * 366 * 24 * 60 * 60 * 1000
  for (let i = 0; i < 60 * 24 * 366 * 4; i++) {
    const candidate = new Date(from.getTime() + i * 60_000)
    candidate.setSeconds(0, 0)
    if (cronMatches(cron, candidate)) {
      return candidate.getTime()
    }
  }
  return from.getTime() + horizonMs
}

/* ───────────────────── create-time validation ───────────────────── */

function isIntInRange(s: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(s)) return false
  const n = Number(s)
  return n >= min && n <= max
}

/**
 * Validate a single field against the forms `matchField` can actually
 * evaluate: `*`, `*\/step`, `N`, `N/step`, `N-M`, and comma lists of `N`.
 * Bounds mirror [min, max] of the field's range.
 */
function isValidField(field: string, min: number, max: number): boolean {
  if (field === "*") return true
  if (field.includes("/")) {
    const parts = field.split("/")
    if (parts.length !== 2) return false
    const [base, step] = parts
    if (!/^\d+$/.test(step ?? "") || Number(step) < 1) return false
    if (base !== "*" && !isIntInRange(base ?? "", min, max)) return false
    return true
  }
  if (field.includes(",")) {
    return field.split(",").every((part) => isIntInRange(part, min, max))
  }
  if (field.includes("-")) {
    const parts = field.split("-")
    if (parts.length !== 2) return false
    const [start, end] = parts
    if (!isIntInRange(start ?? "", min, max) || !isIntInRange(end ?? "", min, max)) return false
    return Number(start) <= Number(end)
  }
  return isIntInRange(field, min, max)
}

/**
 * Reject un-parseable expressions at CREATE time (round 13). The old code
 * accepted anything: `computeNextFire` found no match in its 7-day scan,
 * took the +24h fallback, and a typo like `banana` became a silent DAILY
 * job that fired forever. Bounds: [0-59] [0-23] [1-31] [1-12] [0-6].
 */
export function isValidCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const bounds: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ]
  return fields.every((field, i) => isValidField(field, bounds[i]![0], bounds[i]![1]))
}

export function listCronJobs(): CronJob[] {
  return [...jobs.values()]
}

export function tickCronJobs(onFire: (job: CronJob) => Promise<void>): void {
  const now = Date.now()
  for (const job of jobs.values()) {
    if (job.nextFireAt <= now) {
      void onFire(job)
      job.lastFiredAt = now
      if (job.recurring) {
        job.nextFireAt = computeNextFire(job.cron, new Date(now + 60_000))
      } else {
        jobs.delete(job.id)
      }
    }
  }
}

const cronCreateDef: ToolDefinition = {
  timeoutMs: 30_000,
  name: "nemo__CronCreate",
  description: "Schedule a prompt to be re-injected at a future time. Use cron syntax: M H DoM Mon DoW.",
  parameters: {
    type: "object",
    required: ["cron", "prompt"],
    properties: {
      cron: { type: "string", description: "Standard 5-field cron expression in local time." },
      prompt: { type: "string", description: "The prompt to enqueue at each fire time." },
      recurring: { type: "boolean", description: "true (default) = fire every match; false = fire once then delete." },
    },
  },
}

export function createCronCreateTool(): Tool {
  return {
    definition: cronCreateDef,
    async execute(_id, args, _signal, _update, _context) {
      const cron = String(args.cron ?? "")
      const prompt = String(args.prompt ?? "")
      const recurring = args.recurring !== false
      if (!cron || !prompt) return textResult("Missing 'cron' or 'prompt'.", /*isError*/ true)
      if (!isValidCron(cron)) {
        return textResult(
          `Invalid cron expression: ${cron} (expected 5 fields: minute hour day-of-month month day-of-week — ` +
            `each one of *, N, N-M, N/step, or comma lists)`,
          /*isError*/ true,
        )
      }
      const id = nextId()
      const nextFireAt = computeNextFire(cron)
      jobs.set(id, { id, cron, prompt, recurring, createdAt: Date.now(), nextFireAt })
      return textResult(
        `Scheduled ${id}: next fire at ${new Date(nextFireAt).toISOString()} (cron: ${cron}, recurring: ${recurring})`,
      )
    },
  }
}

const cronDeleteDef: ToolDefinition = {
  timeoutMs: 30_000,
  name: "nemo__CronDelete",
  description: "Cancel a cron job previously scheduled with CronCreate.",
  parameters: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "Job ID returned by CronCreate." } },
  },
}

export function createCronDeleteTool(): Tool {
  return {
    definition: cronDeleteDef,
    async execute(_id, args) {
      const id = String(args.id ?? "")
      if (!jobs.has(id)) return textResult(`No such job: ${id}`, /*isError*/ true)
      jobs.delete(id)
      return textResult(`Deleted ${id}`)
    },
  }
}

const cronListDef: ToolDefinition = {
  timeoutMs: 30_000,
  name: "nemo__CronList",
  description: "List all cron jobs scheduled via CronCreate in this session.",
  parameters: { type: "object", required: [], properties: {} },
}

export function createCronListTool(): Tool {
  return {
    definition: cronListDef,
    async execute() {
      const all = listCronJobs()
      if (all.length === 0) return textResult("No cron jobs scheduled.")
      const rows = all.map(
        (j) =>
          `${j.id} | ${j.cron} | ${j.recurring ? "recurring" : "once"} | next: ${new Date(j.nextFireAt).toISOString()}`,
      )
      return textResult(rows.join("\n"))
    },
  }
}
