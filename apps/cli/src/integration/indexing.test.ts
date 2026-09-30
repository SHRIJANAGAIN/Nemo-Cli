/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IndexingService } from "./indexing.js"

/**
 * run() holds "running" until its (single, 100ms) internal timer resolves,
 * then settles idle at 100% with a lastRun stamp — fake timers keep the
 * test instant and pin the intermediate state the UI polls. The error
 * branch of run() is unreachable (indexFiles has no failure path) and is
 * therefore not exercised here.
 */
beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("IndexingService configuration", () => {
  it("starts enabled with hourly, 1MB, node_modules/.git/dist/build defaults", () => {
    const service = new IndexingService()
    expect(service.getConfig()).toEqual({
      enabled: true,
      interval: 3600000,
      maxFileSize: 1024 * 1024,
      excludedPaths: ["node_modules", ".git", "dist", "build"],
    })
  })

  it("setConfig merges partially and replaces array fields wholesale", () => {
    const service = new IndexingService()
    service.setConfig({ interval: 5000, excludedPaths: ["vendor"] })
    expect(service.getConfig().interval).toBe(5000)
    expect(service.getConfig().excludedPaths).toEqual(["vendor"])
    // Untouched keys keep their defaults.
    expect(service.getConfig().enabled).toBe(true)
    expect(service.getConfig().maxFileSize).toBe(1024 * 1024)
  })
})

describe("IndexingService.run", () => {
  it("reports idle/0 before any run", () => {
    expect(new IndexingService().getState()).toEqual({ status: "idle", progress: 0 })
  })

  it("holds 'running' while indexing, then settles idle at 100% with lastRun", async () => {
    const service = new IndexingService()
    vi.setSystemTime(new Date("2026-05-05T00:00:00.000Z"))

    const running = service.run()
    // Synchronous half of the run: visible to pollers immediately.
    expect(service.getState()).toEqual({ status: "running", progress: 0 })

    await vi.advanceTimersByTimeAsync(100)
    await running

    const state = service.getState()
    expect(state.status).toBe("idle")
    expect(state.progress).toBe(100)
    expect(state.lastRun).toBeInstanceOf(Date)
    expect(state.lastRun?.getTime()).toBe(Date.parse("2026-05-05T00:00:00.100Z"))
    expect(state.error).toBeUndefined()
  })

  it("runs are sequential snapshots: a fresh service starts idle again", async () => {
    const service = new IndexingService()
    const first = service.run()
    await vi.advanceTimersByTimeAsync(100)
    await first
    expect(service.getState().status).toBe("idle")

    const second = new IndexingService()
    expect(second.getState()).toEqual({ status: "idle", progress: 0 })
  })
})
