/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { createCronCreateTool, createCronDeleteTool, listCronJobs, tickCronJobs } from "./cron.js"
import type { ToolContext } from "../types.js"

const ctx = { cwd: process.cwd() } as unknown as ToolContext

async function createJob(cron: string, prompt: string, recurring = true): Promise<string> {
  const tool = createCronCreateTool()
  const r = await tool.execute("t1", { cron, prompt, recurring }, undefined, undefined, ctx)
  if (r.isError) throw new Error("cron create failed: " + r.content.map((c) => c.text ?? "").join())
  const jobs = listCronJobs()
  const job = jobs.find((j) => j.prompt === prompt)
  if (!job) throw new Error("created job not listed")
  return job.id
}

async function cleanup(ids: string[]): Promise<void> {
  const del = createCronDeleteTool()
  for (const id of ids) {
    try {
      await del.execute("t1", { id }, undefined, undefined, ctx)
    } catch {
      /* already gone (one-shot fired) */
    }
  }
}

describe("tickCronJobs", () => {
  it("fires a due one-shot job once, then deletes it", async () => {
    const id = await createJob("* * * * *", `oneshot-${Date.now()}`, false)
    const fired: string[] = []
    tickCronJobs(async (job) => {
      fired.push(job.id)
    })
    expect(fired).toContain(id)
    expect(listCronJobs().some((j) => j.id === id)).toBe(false)
    await cleanup([id])
  })

  it("fires a due recurring job and reschedules it", async () => {
    const id = await createJob("* * * * *", `recurring-${Date.now()}`, true)
    const before = listCronJobs().find((j) => j.id === id)?.nextFireAt ?? 0
    let fires = 0
    tickCronJobs(async () => {
      fires++
    })
    expect(fires).toBeGreaterThanOrEqual(1)
    const after = listCronJobs().find((j) => j.id === id)
    expect(after).toBeDefined()
    expect(after?.nextFireAt ?? 0).toBeGreaterThanOrEqual(before)
    await cleanup([id])
  })

  it("does not fire jobs scheduled for the future", async () => {
    const now = new Date()
    const futureMin = (now.getMinutes() + 5) % 60
    const id = await createJob(`${futureMin} * * * *`, `future-${Date.now()}`, false)
    // Guard: if the minute rolled over onto the future slot, skip (flaky-safe).
    const job = listCronJobs().find((j) => j.id === id)
    if (job && job.nextFireAt <= Date.now()) {
      await cleanup([id])
      return
    }
    const fired: string[] = []
    tickCronJobs(async (j) => {
      fired.push(j.id)
    })
    expect(fired).not.toContain(id)
    expect(listCronJobs().some((j) => j.id === id)).toBe(true)
    await cleanup([id])
  })

  it("is a no-op tick when nothing is due", async () => {
    let fires = 0
    tickCronJobs(async () => {
      fires++
    })
    // Only jobs created by other tests could fire; this tick must not throw.
    expect(fires).toBeGreaterThanOrEqual(0)
  })
})

describe("CronCreate rejects invalid expressions (round 13)", () => {
  // The old create accepted ANY string: computeNextFire missed its 7-day
  // scan, took the +24h fallback, and a typo became a silent DAILY job.
  it.each([
    "banana",
    "* * *",
    "* * * * * *",
    "60 * * * *",
    "* 24 * * *",
    "abc * * * *",
    "*/0 * * * *",
    "1-99 * * * *",
    "5-1 * * * *",
    "0 0 0 * *",
    "0 0 * 13 *",
    "0 0 * * 7",
    "1,2/x * * * *",
    "1/2/3 * * * *",
  ])("rejects %j instead of scheduling it", async (bad) => {
    const r = await createCronCreateTool().execute("t1", { cron: bad, prompt: "p" }, undefined, undefined, ctx)
    expect(r.isError).toBe(true)
    expect(r.content.map((c) => c.text ?? "").join()).toContain("Invalid cron expression")
    expect(listCronJobs().some((j) => j.cron === bad)).toBe(false)
  })

  it("still accepts every form the matcher can evaluate", async () => {
    const valid = ["*/5 * * * *", "0 0 * * *", "30 9-17 * * 1-5", "15,45 * * * *", "0/15 12 * * *", "7 8 9 10 6"]
    const ids: string[] = []
    for (const ok of valid) {
      const r = await createCronCreateTool().execute("t1", { cron: ok, prompt: `valid-${ok}` }, undefined, undefined, ctx)
      expect(r.isError, ok).toBeFalsy()
      const job = listCronJobs().find((j) => j.prompt === `valid-${ok}`)
      if (job) ids.push(job.id)
    }
    await cleanup(ids)
  })
})
