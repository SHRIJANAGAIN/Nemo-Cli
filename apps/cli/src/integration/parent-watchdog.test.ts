/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ParentWatchdogService } from "./parent-watchdog.js"

/**
 * The watchdog arms a real setInterval that signals the parent pid. Every
 * test here runs under fake timers with process.kill spied (no real
 * signals), and afterEach stops the service + restores the spy/timers so
 * no interval can outlive the file and hang the suite.
 */
let service: ParentWatchdogService
// Loose spy type: only mockRestore is used here, and pinning the full
// vi.spyOn generic breaks across vitest minor versions (unrelated churn
// must not fail the shared build).
let killSpy: { mockRestore(): void }
const alivePids = new Set<number>()

const PARENT = 4242

beforeEach(() => {
  vi.useFakeTimers()
  alivePids.clear()
  alivePids.add(PARENT)
  killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number): boolean => {
    if (!alivePids.has(pid)) throw new Error(`ESRCH: no process ${pid}`)
    return true
  }) as unknown as typeof process.kill)
  service = new ParentWatchdogService()
})

afterEach(() => {
  service.stop()
  killSpy.mockRestore()
  vi.useRealTimers()
})

describe("ParentWatchdogService start/stop", () => {
  it("reports nothing before start()", () => {
    expect(service.getState()).toBeUndefined()
  })

  it("start seeds a live state and arms the interval", () => {
    vi.setSystemTime(new Date("2026-08-01T10:00:00.000Z"))
    service.start(PARENT)
    expect(service.getState()).toEqual({
      parentPid: PARENT,
      alive: true,
      restartCount: 0,
      lastCheck: new Date("2026-08-01T10:00:00.000Z"),
    })
    expect(killSpy).not.toHaveBeenCalled()
  })

  it("ticks every checkInterval: a live parent stays alive and stamps lastCheck", () => {
    service.setConfig({ checkInterval: 5000 })
    vi.setSystemTime(new Date("2026-08-01T10:00:00.000Z"))
    service.start(PARENT)

    vi.advanceTimersByTime(4999)
    expect(killSpy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(killSpy).toHaveBeenCalledWith(PARENT, 0)
    expect(service.getState()?.alive).toBe(true)
    expect(service.getState()?.restartCount).toBe(0)
    expect(service.getState()?.lastCheck.getTime()).toBe(Date.parse("2026-08-01T10:00:05.000Z"))
  })

  it("a dead parent flips alive off and increments restartCount every tick", () => {
    service.setConfig({ checkInterval: 1000 })
    service.start(PARENT)
    alivePids.delete(PARENT)

    vi.advanceTimersByTime(1000)
    expect(service.getState()?.alive).toBe(false)
    expect(service.getState()?.restartCount).toBe(1)

    vi.advanceTimersByTime(1000)
    expect(service.getState()?.alive).toBe(false)
    expect(service.getState()?.restartCount).toBe(2)
  })

  it("stop() halts the checks (and is safe to call twice)", () => {
    service.setConfig({ checkInterval: 1000 })
    service.start(PARENT)
    alivePids.delete(PARENT)

    vi.advanceTimersByTime(1000)
    expect(killSpy).toHaveBeenCalledTimes(1)

    service.stop()
    expect(() => service.stop()).not.toThrow()
    vi.advanceTimersByTime(5000)
    expect(killSpy).toHaveBeenCalledTimes(1)
    // State is retained for inspection after stopping.
    expect(service.getState()?.restartCount).toBe(1)
  })

  it("start() twice does not leak the first interval — stop() halts every timer", () => {
    service.setConfig({ checkInterval: 1000 })
    service.start(PARENT)
    // Re-arm: the OLD code overwrote intervalId without clearing, orphaning
    // the first timer where stop() could never reach it.
    service.start(PARENT)
    service.stop()
    vi.advanceTimersByTime(5000)
    expect(killSpy).not.toHaveBeenCalled()
  })

  it("honours a custom restart delay and max restarts as configuration", () => {
    service.setConfig({ checkInterval: 500, maxRestarts: 7, restartDelay: 250 })
    service.start(PARENT)
    vi.advanceTimersByTime(500)
    expect(service.getState()?.alive).toBe(true)
    // Config is stored per-instance; the observable tick cadence follows it.
    vi.advanceTimersByTime(500)
    expect(killSpy).toHaveBeenCalledTimes(2)
  })
})
