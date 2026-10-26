/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  DEFAULT_DEVELOPER_MODE_CONFIG,
  DeveloperModeEngine,
  SubagentOrchestrator,
  type DeveloperModeConfig,
  type SubagentTask,
} from "./index.js"

interface MonitorPair {
  agentA: SubagentTask
  agentB: SubagentTask
  status: string
}

interface Callbacks {
  updates: SubagentTask[]
  completed: SubagentTask[]
  failed: Array<{ task: SubagentTask; error: string }>
  monitors: MonitorPair[][]
}

type Runner = {
  subagentRunner?: (task: { name: string; prompt: string }) => Promise<string>
  agentRunner?: (task: { name: string; prompt: string }) => Promise<string>
}

let tmp = ""

const makeCallbacks = (): Callbacks => ({ updates: [], completed: [], failed: [], monitors: [] })

const makeEngine = (config: Partial<DeveloperModeConfig> = {}): DeveloperModeEngine =>
  new DeveloperModeEngine(tmp, { enabled: true, ...config })

const makeOrchestrator = (
  config: Partial<DeveloperModeConfig>,
  callbacks: Callbacks,
  runners: Runner = {},
): SubagentOrchestrator =>
  new SubagentOrchestrator({
    config: { ...DEFAULT_DEVELOPER_MODE_CONFIG, enabled: true, ...config },
    // The orchestrator hands callbacks the live task object, which it keeps
    // mutating (running -> completed). Snapshot each event so assertions see
    // the state at fire time.
    onTaskUpdate: (task) => callbacks.updates.push({ ...task }),
    onTaskComplete: (task) => callbacks.completed.push({ ...task }),
    onTaskFail: (task, error) => callbacks.failed.push({ task: { ...task }, error }),
    onCrossMonitor: (pairs) => callbacks.monitors.push(pairs),
    ...runners,
  })

/**
 * The interval path is exercised with a RAW `DeveloperModeEngine` — prototype
 * methods and no rebinding facade. `runTask` stores `crossMonitorSubagents`
 * behind an invoker closure (subagent-orchestrator.ts), so the monitor tick
 * keeps its receiver; a detached method reference would throw
 * `this.getAllSubagents is not a function` on every tick. This test fails if
 * anyone reintroduces the detached store.
 */

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-orch-"))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("SubagentOrchestrator.runTask", () => {
  it("completes through subagentRunner and fires update/complete callbacks", async () => {
    const callbacks = makeCallbacks()
    const orchestrator = makeOrchestrator({}, callbacks, {
      subagentRunner: async (task) => `did ${task.prompt}`,
    })
    const engine = makeEngine()

    const task = await orchestrator.runTask(engine, "worker", "do the thing", "parent-1")
    expect(task.status).toBe("completed")
    expect(task.result).toBe("did do the thing")
    expect(task.parentId).toBe("parent-1")
    expect(typeof task.startedAt).toBe("number")
    expect(typeof task.finishedAt).toBe("number")

    expect(callbacks.updates).toHaveLength(1)
    expect(callbacks.updates[0].status).toBe("running")
    expect(callbacks.completed).toHaveLength(1)
    expect(callbacks.completed[0].id).toBe(task.id)
    expect(callbacks.failed).toEqual([])
  })

  it("prefers agentRunner when both runners are configured", async () => {
    const callbacks = makeCallbacks()
    const orchestrator = makeOrchestrator({}, callbacks, {
      subagentRunner: async () => "from subagentRunner",
      agentRunner: async () => "from agentRunner",
    })
    const task = await orchestrator.runTask(makeEngine(), "worker", "p")
    expect(task.result).toBe("from agentRunner")
    expect(task.status).toBe("completed")
  })

  it("fails the task when no runner is configured", async () => {
    const callbacks = makeCallbacks()
    const orchestrator = makeOrchestrator({}, callbacks)
    const task = await orchestrator.runTask(makeEngine(), "worker", "p")
    expect(task.status).toBe("failed")
    expect(task.error).toBe("No subagent runner configured; cannot execute subagent task.")
    expect(callbacks.failed).toHaveLength(1)
    expect(callbacks.failed[0].error).toBe("No subagent runner configured; cannot execute subagent task.")
    expect(callbacks.completed).toEqual([])
  })

  it("propagates runner failures into the failed callback", async () => {
    const callbacks = makeCallbacks()
    const orchestrator = makeOrchestrator({}, callbacks, {
      subagentRunner: async () => {
        throw new Error("runner exploded")
      },
    })
    const task = await orchestrator.runTask(makeEngine(), "worker", "p")
    expect(task.status).toBe("failed")
    expect(task.error).toBe("runner exploded")
    expect(callbacks.failed[0].error).toBe("runner exploded")
  })

  it("cancels the oldest active subagent when the cap is reached", async () => {
    const callbacks = makeCallbacks()
    const orchestrator = makeOrchestrator({ maxSubagents: 1 }, callbacks, {
      subagentRunner: async () => "ok",
    })
    const engine = makeEngine({ maxSubagents: 1 })
    const oldest = engine.startSubagent("oldest", "p")
    engine.updateSubagent(oldest.id, { status: "running" })

    const task = await orchestrator.runTask(engine, "newborn", "p")
    expect(engine.getSubagent(oldest.id)?.status).toBe("cancelled")
    expect(task.status).toBe("completed")
  })
})

describe("SubagentOrchestrator.runParallelTasks", () => {
  it("returns [] and reports no monitor pairs for an empty task list", async () => {
    const callbacks = makeCallbacks()
    const orchestrator = makeOrchestrator({ maxSubagents: 2 }, callbacks, {
      subagentRunner: async () => "ok",
    })
    const results = await orchestrator.runParallelTasks(makeEngine(), [], "root")
    expect(results).toEqual([])
    expect(callbacks.monitors).toEqual([])
  })

  it("batches by maxSubagents, links peers and cross-monitors after each batch", async () => {
    const callbacks = makeCallbacks()
    const orchestrator = makeOrchestrator({ maxSubagents: 2 }, callbacks, {
      subagentRunner: async (task) => `done ${task.name}`,
    })
    const engine = makeEngine({ maxSubagents: 2 })
    const tasks = ["a", "b", "c", "d", "e"].map((name) => ({ name, prompt: `p-${name}` }))

    const results = await orchestrator.runParallelTasks(engine, tasks, "root")

    expect(results).toHaveLength(5)
    expect(results.map((t) => t.status)).toEqual(Array(5).fill("completed"))
    expect(results.map((t) => t.result)).toEqual(tasks.map((t) => `done ${t.name}`))
    expect(results.every((t) => t.parentId === "root")).toBe(true)

    // 5 tasks / maxSubagents 2 → three batches → one cross-monitor per batch.
    expect(callbacks.monitors).toHaveLength(3)
    for (const batch of callbacks.monitors) {
      expect(batch.length).toBeGreaterThan(0)
      expect(batch.every((pair) => pair.status === "both_done")).toBe(true)
    }

    // Peer wiring: within a batch only idx > 0 chains to the previous result.
    expect(results[1].peerId).toBeUndefined()
    expect(results[3].peerId).toBe(results[1].id)
  })
})

describe("SubagentOrchestrator monitoring lifecycle", () => {
  it("start() arms the interval, stop() disarms it; double-start is a no-op", async () => {
    vi.useFakeTimers()
    try {
      const callbacks = makeCallbacks()
      const orchestrator = makeOrchestrator({ subagentMonitorIntervalMs: 25 }, callbacks, {
        subagentRunner: async () => "ok",
      })
      const engine = makeEngine()
      orchestrator.start()
      orchestrator.start() // idempotent — still a single interval

      // Raw engine, prototype methods, no facade: the monitor interval calls
      // crossMonitorSubagents through runTask's invoker closure (see the
      // module doc above) — a detached reference would throw every tick.
      await orchestrator.runTask(engine, "a", "p", "shared")
      await orchestrator.runTask(engine, "b", "p", "shared")
      expect(callbacks.monitors).toEqual([]) // timer has not fired yet

      await vi.advanceTimersByTimeAsync(30)
      expect(callbacks.monitors).toHaveLength(1)
      expect(callbacks.monitors[0][0].status).toBe("both_done")

      orchestrator.stop()
      await vi.advanceTimersByTimeAsync(200)
      expect(callbacks.monitors).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not arm the interval when parallelism or the interval is disabled", async () => {
    vi.useFakeTimers()
    try {
      const noParallel = makeCallbacks()
      const orchestratorA = makeOrchestrator({ parallelSubagents: false, subagentMonitorIntervalMs: 10 }, noParallel, {
        subagentRunner: async () => "ok",
      })
      const noInterval = makeCallbacks()
      const orchestratorB = makeOrchestrator({ subagentMonitorIntervalMs: 0 }, noInterval, {
        subagentRunner: async () => "ok",
      })
      orchestratorA.start()
      orchestratorB.start()

      const engineA = makeEngine({ parallelSubagents: false })
      await orchestratorA.runTask(engineA, "a", "p", "shared")
      await orchestratorA.runTask(engineA, "b", "p", "shared")
      const engineB = makeEngine()
      await orchestratorB.runTask(engineB, "a", "p", "shared")
      await orchestratorB.runTask(engineB, "b", "p", "shared")

      await vi.advanceTimersByTimeAsync(500)
      expect(noParallel.monitors).toEqual([])
      expect(noInterval.monitors).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("SubagentOrchestrator.shouldAutoSpawnBugFix", () => {
  it("triggers on repeated tool errors, permission denials and TUI errors only", () => {
    const callbacks = makeCallbacks()
    const orchestrator = makeOrchestrator({}, callbacks)
    expect(orchestrator.shouldAutoSpawnBugFix("tool_error", 1)).toBe(false)
    expect(orchestrator.shouldAutoSpawnBugFix("tool_error", 2)).toBe(true)
    expect(orchestrator.shouldAutoSpawnBugFix("tool_error", 9)).toBe(true)
    expect(orchestrator.shouldAutoSpawnBugFix("permission_denied", 0)).toBe(true)
    expect(orchestrator.shouldAutoSpawnBugFix("tui_error", 0)).toBe(true)
    expect(orchestrator.shouldAutoSpawnBugFix("info", 5)).toBe(false)
  })
})
