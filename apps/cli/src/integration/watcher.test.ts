/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { WatcherService, type WatcherEvent } from "./watcher.js"

/**
 * WatcherService's "watchers" are bookkeeping records, not real fs
 * handles — the hazard this file guards against is the EventEmitter
 * listener set, so every test tears the service down in afterEach.
 */
let service: WatcherService

beforeEach(() => {
  service = new WatcherService()
})

afterEach(() => {
  service.close()
  service.removeAllListeners()
})

describe("WatcherService configuration", () => {
  it("configure() accepts partial config without disturbing watch behavior", () => {
    // WatcherConfig currently has no getter — the stored values are not
    // observable through the public API (dead state, noted in the audit),
    // so the pin here is that configuring never breaks the lifecycle.
    service.configure({ debounce: 250, paths: ["src"], ignored: ["vendor"] })

    const starts: unknown[] = []
    service.on("start", (payload) => starts.push(payload))
    service.watch("src")
    expect(starts).toEqual([{ path: "src" }])
    expect(service.getWatchedPaths()).toEqual(["src"])
  })
})

describe("WatcherService watch lifecycle", () => {
  it("watch() registers the path and emits start exactly once", () => {
    const starts: unknown[] = []
    service.on("start", (payload) => starts.push(payload))

    service.watch("/repo/src")
    expect(starts).toEqual([{ path: "/repo/src" }])
    expect(service.getWatchedPaths()).toEqual(["/repo/src"])

    // Re-watching an already-watched path is a no-op.
    service.watch("/repo/src")
    expect(starts).toHaveLength(1)
    expect(service.getWatchedPaths()).toEqual(["/repo/src"])
  })

  it("tracks multiple paths in insertion order", () => {
    service.watch("a")
    service.watch("b")
    service.watch("c")
    expect(service.getWatchedPaths()).toEqual(["a", "b", "c"])
  })

  it("unwatch() stops a path, emits stop, and reports misses as false", () => {
    const stops: unknown[] = []
    service.on("stop", (payload) => stops.push(payload))
    service.watch("/repo")

    expect(service.unwatch("/repo")).toBe(true)
    expect(stops).toEqual([{ path: "/repo" }])
    expect(service.getWatchedPaths()).toEqual([])

    expect(service.unwatch("/repo")).toBe(false)
    expect(stops).toHaveLength(1)
  })

  it("close() drops every watcher so later unwatch() misses", () => {
    service.watch("a")
    service.watch("b")
    service.close()
    expect(service.getWatchedPaths()).toEqual([])
    expect(service.unwatch("a")).toBe(false)
  })
})

describe("WatcherService event relay", () => {
  it("emitEvent forwards add/change/unlink events verbatim to 'change' listeners", () => {
    const received: WatcherEvent[] = []
    service.on("change", (event: WatcherEvent) => received.push(event))

    const added: WatcherEvent = { type: "add", path: "src/new.ts", timestamp: new Date("2026-01-01T00:00:00Z") }
    const removed: WatcherEvent = { type: "unlink", path: "src/old.ts", timestamp: new Date("2026-01-01T00:00:01Z") }
    service.emitEvent(added)
    service.emitEvent(removed)

    expect(received).toEqual([added, removed])
    expect(received[0]?.type).toBe("add")
    expect(received[1]?.type).toBe("unlink")
  })

  it("emits directory events with their own type labels", () => {
    const received: string[] = []
    service.on("change", (event: WatcherEvent) => received.push(event.type))
    service.emitEvent({ type: "addDir", path: "src", timestamp: new Date() })
    service.emitEvent({ type: "unlinkDir", path: "src", timestamp: new Date() })
    expect(received).toEqual(["addDir", "unlinkDir"])
  })

  it("is a plain EventEmitter: unknown event names have no listeners", () => {
    const received: string[] = []
    service.on("change", (event: WatcherEvent) => received.push(event.type))
    const hadListeners = service.emit("spurious", { path: "x" })
    expect(hadListeners).toBe(false)
    expect(received).toEqual([])
  })
})
