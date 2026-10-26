/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PresenceService, type PresenceState } from "./presence.js"

/**
 * PresenceService is pure state + listener fan-out (no timers are created —
 * broadcastInterval is only a policy value), so the contract is: every
 * mutation notifies every live listener exactly once with the new state,
 * and unsubscribing stops the fan-out.
 */
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-07-01T09:00:00.000Z"))
})

afterEach(() => {
  vi.useRealTimers()
})

describe("PresenceService state", () => {
  it("starts as the local user, online, with no session", () => {
    const state = new PresenceService().getState()
    expect(state.userId).toBe("local")
    expect(state.status).toBe("online")
    expect(state.lastSeen).toBeInstanceOf(Date)
    expect(state.currentSession).toBeUndefined()
  })

  it("setStatus updates status and refreshes lastSeen", () => {
    const service = new PresenceService()
    vi.setSystemTime(new Date("2026-07-01T09:05:00.000Z"))
    service.setStatus("away")
    expect(service.getState().status).toBe("away")
    expect(service.getState().lastSeen.getTime()).toBe(Date.parse("2026-07-01T09:05:00.000Z"))
  })

  it("setCurrentSession records the session and preserves status", () => {
    const service = new PresenceService()
    service.setStatus("busy")
    service.setCurrentSession("sess-42")
    expect(service.getState()).toMatchObject({
      status: "busy",
      currentSession: "sess-42",
    })
  })
})

describe("PresenceService subscriptions", () => {
  it("notifies every listener once per mutation with the fresh state", () => {
    const service = new PresenceService()
    const first: PresenceState[] = []
    const second: PresenceState[] = []
    service.subscribe((state) => first.push(state))
    service.subscribe((state) => second.push(state))

    service.setStatus("offline")
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(first[0]?.status).toBe("offline")
    expect(second[0]).toBe(first[0])

    service.setCurrentSession("sess-1")
    expect(first).toHaveLength(2)
    expect(first[1]?.currentSession).toBe("sess-1")
  })

  it("unsubscribing stops notifications without disturbing other listeners", () => {
    const service = new PresenceService()
    const kept: PresenceState[] = []
    const dropped: PresenceState[] = []
    service.subscribe((state) => kept.push(state))
    const unsubscribe = service.subscribe((state) => dropped.push(state))

    service.setStatus("away")
    expect(unsubscribe()).toBe(true)

    service.setStatus("busy")
    expect(dropped).toHaveLength(1)
    expect(kept).toHaveLength(2)
    // Unsubscribing twice is harmless.
    expect(unsubscribe()).toBe(false)
  })

  it("listeners see no notification without a mutation", () => {
    const service = new PresenceService()
    const seen: PresenceState[] = []
    service.subscribe((state) => seen.push(state))
    service.getState()
    expect(seen).toHaveLength(0)
  })
})

describe("PresenceService policy", () => {
  it("starts with idle 5min / away 10min / broadcast 30s", () => {
    expect(new PresenceService().getPolicy()).toEqual({
      idleTimeout: 300000,
      awayTimeout: 600000,
      broadcastInterval: 30000,
    })
  })

  it("setPolicy merges partially", () => {
    const service = new PresenceService()
    service.setPolicy({ awayTimeout: 60000 })
    expect(service.getPolicy()).toEqual({
      idleTimeout: 300000,
      awayTimeout: 60000,
      broadcastInterval: 30000,
    })
  })
})
