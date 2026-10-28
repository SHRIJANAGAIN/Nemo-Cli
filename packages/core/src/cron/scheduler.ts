/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"

export interface CronJob {
  id: string
  name: string
  schedule: string
  prompt: string
  model?: string
  provider?: string
  skills?: string[]
  workdir?: string
  contextFrom?: string
  enabled: boolean
  lastRunAt?: string
  nextRunAt?: string
  createdAt: string
}

export interface PulseConfig {
  jobsFile: string
  tickIntervalMs?: number
  catchupWindowMs?: number
}

export class PulseScheduler {
  private readonly jobsFile: string
  private readonly tickIntervalMs: number
  private readonly catchupWindowMs: number
  private jobs: Map<string, CronJob> = new Map()
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  /** Occurrences already fired (by job id), so one due `nextRunAt` fires once. */
  private firedAt: Map<string, string> = new Map()

  constructor(config: PulseConfig) {
    this.jobsFile = config.jobsFile
    this.tickIntervalMs = config.tickIntervalMs ?? 60_000
    this.catchupWindowMs = config.catchupWindowMs ?? 120_000
  }

  async load(): Promise<void> {
    if (!fs.existsSync(this.jobsFile)) return
    try {
      const raw = fs.readFileSync(this.jobsFile, "utf8")
      const data = JSON.parse(raw) as CronJob[]
      this.jobs = new Map(data.map((j) => [j.id, j]))
    } catch {
      this.jobs = new Map()
    }
  }

  async save(): Promise<void> {
    const dir = path.dirname(this.jobsFile)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(this.jobsFile, JSON.stringify(Array.from(this.jobs.values()), null, 2))
  }

  list(): CronJob[] {
    return Array.from(this.jobs.values()).filter((j) => j.enabled)
  }

  get(id: string): CronJob | undefined {
    return this.jobs.get(id)
  }

  async add(job: Omit<CronJob, "id" | "createdAt">): Promise<CronJob> {
    const id = `cron_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const entry: CronJob = {
      ...job,
      id,
      createdAt: new Date().toISOString(),
    }
    this.jobs.set(id, entry)
    await this.save()
    return entry
  }

  async remove(id: string): Promise<void> {
    this.jobs.delete(id)
    await this.save()
  }

  async enable(id: string): Promise<void> {
    const job = this.jobs.get(id)
    if (job) {
      job.enabled = true
      await this.save()
    }
  }

  async disable(id: string): Promise<void> {
    const job = this.jobs.get(id)
    if (job) {
      job.enabled = false
      await this.save()
    }
  }

  start(onTick: (job: CronJob) => void): void {
    if (this.running) return
    this.running = true
    this.tickTimer = setInterval(() => {
      this.tick(onTick)
    }, this.tickIntervalMs)
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    this.running = false
  }

  private tick(onTick: (job: CronJob) => void): void {
    const now = Date.now()
    for (const job of this.jobs.values()) {
      if (!job.enabled) continue
      const next = job.nextRunAt ? Date.parse(job.nextRunAt) : null
      if (next && now >= next && now - next <= this.catchupWindowMs) {
        // One OCCURRENCE fires once. Without this a job whose `nextRunAt` is
        // already due re-fires on EVERY tick inside the catchup window (a 60s
        // tick runs a due job ~3 times before the window lapses). The caller
        // advances `nextRunAt` after the run; until it does, the same
        // occurrence must not be handed to `onTick` again.
        if (this.firedAt.get(job.id) === job.nextRunAt) continue
        this.firedAt.set(job.id, job.nextRunAt ?? "")
        onTick(job)
      }
    }
  }
}
