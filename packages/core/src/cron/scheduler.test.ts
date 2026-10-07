/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { PulseScheduler } from "./scheduler.js"
import type { CronJob } from "./scheduler.js"

let tmp = ""
let jobsFile = ""

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-cron-"))
  // Parent directory intentionally missing so save() exercises mkdir.
  jobsFile = path.join(tmp, "state", "jobs.json")
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const job = (over: Partial<CronJob> = {}): Omit<CronJob, "id" | "createdAt"> => ({
  name: "nightly",
  schedule: "0 * * * *",
  prompt: "run the checks",
  enabled: true,
  ...over,
})

describe("PulseScheduler persistence", () => {
  it("loads nothing when the jobs file is missing", async () => {
    const s = new PulseScheduler({ jobsFile })
    await s.load()
    expect(s.list()).toEqual([])
  })

  it("adds, persists, and reloads jobs (creating the directory)", async () => {
    const s = new PulseScheduler({ jobsFile })
    const added = await s.add(job())
    expect(added.id).toMatch(/^cron_/)
    expect(added.createdAt).toBeTruthy()
    expect(s.get(added.id)?.prompt).toBe("run the checks")
    expect(fs.existsSync(jobsFile)).toBe(true)

    const reloaded = new PulseScheduler({ jobsFile })
    await reloaded.load()
    expect(reloaded.list().length).toBe(1)
    expect(reloaded.get(added.id)?.name).toBe("nightly")
  })

  it("hides disabled jobs from list but keeps them fetchable", async () => {
    const s = new PulseScheduler({ jobsFile })
    const added = await s.add(job())
    await s.disable(added.id)
    expect(s.list()).toEqual([])
    expect(s.get(added.id)?.enabled).toBe(false)

    await s.enable(added.id)
    expect(s.list().length).toBe(1)
    expect(s.get(added.id)?.enabled).toBe(true)

    // Unknown ids are no-ops.
    await s.disable("nope")
    await s.enable("nope")
    expect(s.list().length).toBe(1)
  })

  it("removes jobs and persists the removal", async () => {
    const s = new PulseScheduler({ jobsFile })
    const added = await s.add(job())
    await s.remove(added.id)
    expect(s.get(added.id)).toBeUndefined()
    expect(s.list()).toEqual([])

    const reloaded = new PulseScheduler({ jobsFile })
    await reloaded.load()
    expect(reloaded.list()).toEqual([])
  })

  it("ignores a corrupt jobs file", async () => {
    fs.mkdirSync(path.dirname(jobsFile), { recursive: true })
    fs.writeFileSync(jobsFile, "{ not json", "utf8")
    const s = new PulseScheduler({ jobsFile })
    await s.load()
    expect(s.list()).toEqual([])
  })

  it("reads a jobs file written directly, filtering disabled entries", async () => {
    fs.mkdirSync(path.dirname(jobsFile), { recursive: true })
    const raw = [
      { id: "cron_a", ...job() },
      { id: "cron_b", ...job({ name: "off", enabled: false }) },
    ]
    fs.writeFileSync(jobsFile, JSON.stringify(raw), "utf8")

    const s = new PulseScheduler({ jobsFile })
    await s.load()
    expect(s.list().map((j) => j.id)).toEqual(["cron_a"])
    expect(s.get("cron_b")?.enabled).toBe(false)
  })
})

describe("PulseScheduler ticking", () => {
  it("fires only due, enabled jobs inside the catchup window", async () => {
    const s = new PulseScheduler({ jobsFile, tickIntervalMs: 15, catchupWindowMs: 60_000 })
    const now = Date.now()
    const due = await s.add({ ...job(), nextRunAt: new Date(now - 5_000).toISOString() })
    await s.add({ ...job(), nextRunAt: new Date(now + 600_000).toISOString() })
    await s.add({ ...job(), nextRunAt: new Date(now - 600_000).toISOString() })
    await s.add({
      ...job(),
      enabled: false,
      nextRunAt: new Date(now - 5_000).toISOString(),
    })

    const fired: string[] = []
    s.start((j) => fired.push(j.id))
    // Second start must be ignored while the scheduler is running.
    s.start(() => {
      fired.push("second")
    })
    await sleep(90)
    s.stop()

    // Fires ONCE per occurrence: several ticks land inside the catchup window,
    // but the SAME due `nextRunAt` must not re-fire the job on each of them.
    expect(fired).toEqual([due.id])
  })

  it("ignores jobs that have never been scheduled", async () => {
    const s = new PulseScheduler({ jobsFile, tickIntervalMs: 15 })
    await s.add(job())
    const fired: string[] = []
    s.start((j) => fired.push(j.id))
    await sleep(60)
    s.stop()
    expect(fired).toEqual([])
  })

  it("stop is safe when the scheduler never started", () => {
    const s = new PulseScheduler({ jobsFile })
    expect(() => s.stop()).not.toThrow()
  })
})
