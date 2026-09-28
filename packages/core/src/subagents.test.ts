/* Copyright 2026 SKT AI LABS PRIVATE LIMITED.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import {
  childDepth,
  createSubagentTask,
  formatWorkerUsage,
  MaxDepthExceeded,
  MAX_SUBAGENT_DEPTH,
  runSubagent,
  SubagentEngine,
  summarizeUsage,
  sumUsage,
} from "./subagents.js"
import type { SubagentTask, WorkerContext, WorkerResult } from "./subagents.js"
import type { TaggedAgentEvent } from "../../protocol/src/index.js"

const stubRunner = (output: string, toolCalls: number) => async () => ({ output, toolCalls })

describe("subagents", () => {
  it("runs at depth+1 with a usage summary", async () => {
    const result = await runSubagent(stubRunner("done", 4), { prompt: "do x", depth: 0, maxToolCalls: 10 })
    expect(result.output).toBe("done")
    expect(result.usage).toMatchObject({ toolCalls: 4, depth: 1, inputChars: 4, outputChars: 4 })
    expect(summarizeUsage(result.usage)).toContain("depth 1")
  })

  it("defaults caller depth to 0", () => {
    expect(childDepth(undefined)).toBe(1)
    expect(childDepth(2)).toBe(3)
  })

  it("refuses past MAX_SUBAGENT_DEPTH", async () => {
    await expect(runSubagent(stubRunner("x", 0), { prompt: "y", depth: MAX_SUBAGENT_DEPTH })).rejects.toBeInstanceOf(
      MaxDepthExceeded,
    )
  })
})

describe("createSubagentTask", () => {
  it("fills crypto.randomUUID ids when none is given", () => {
    const a = createSubagentTask({ description: "a", prompt: "p", type: "general" })
    const b = createSubagentTask({ description: "a", prompt: "p", type: "general" })
    expect(a.id).toBeTruthy()
    expect(a.id).not.toBe(b.id)
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("keeps a caller-provided id and never mutates the input", () => {
    const input = { id: "task-1", description: "d", prompt: "p", type: "explore" }
    const frozen = Object.freeze(input)
    const task = createSubagentTask(frozen)
    expect(task.id).toBe("task-1")
    expect(Object.keys(input)).toEqual(["id", "description", "prompt", "type"])
  })
})

describe("usage summaries", () => {
  it("sums per-task usage into an aggregate", () => {
    const agg = sumUsage([
      { turns: 2, toolCalls: 3, durationMs: 100, tokensIn: 10, tokensOut: 5 },
      { turns: 1, toolCalls: 0, durationMs: 50 },
    ])
    expect(agg).toEqual({ turns: 3, toolCalls: 3, durationMs: 150, tokensIn: 10, tokensOut: 5 })
  })

  it("formats a one-line summary", () => {
    expect(formatWorkerUsage({ turns: 2, toolCalls: 4, durationMs: 12 })).toBe("2 turn(s), 4 tool call(s), 12ms")
    expect(formatWorkerUsage({ turns: 1, toolCalls: 1, durationMs: 3, tokensIn: 7, tokensOut: 9 })).toContain(
      "tokens 7→9",
    )
  })
})

/** Engine tests: injected worker only — zero model calls, zero network. */
describe("SubagentEngine foreground", () => {
  const task = (over: Partial<SubagentTask> = {}): SubagentTask =>
    createSubagentTask({ description: "child work", prompt: "do it", type: "general", ...over })

  it("runs the injected worker at depth+1 and records usage", async () => {
    const seen: WorkerContext[] = []
    const engine = new SubagentEngine({
      runWorker: async (_t, ctx) => {
        seen.push(ctx)
        return { text: "done", usage: { turns: 2, toolCalls: 3, durationMs: 5, tokensIn: 11, tokensOut: 7 } }
      },
    })
    const outcome = await engine.run(task(), { depth: 0 })
    expect(outcome.ok).toBe(true)
    expect(outcome.depth).toBe(1)
    expect(outcome.text).toBe("done")
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ depth: 1, maxDepth: MAX_SUBAGENT_DEPTH })
    expect(engine.usageFor(outcome.id)).toEqual({ turns: 2, toolCalls: 3, durationMs: 5, tokensIn: 11, tokensOut: 7 })
    expect(engine.aggregateUsage()).toEqual({ turns: 2, toolCalls: 3, durationMs: 5, tokensIn: 11, tokensOut: 7 })
    expect(formatWorkerUsage(engine.aggregateUsage())).toContain("2 turn(s)")
  })

  it("emits protocol subagent_start / subagent_end around the run", async () => {
    const events: TaggedAgentEvent[] = []
    const engine = new SubagentEngine({
      runWorker: async () => ({ text: "hi", usage: { turns: 1, toolCalls: 0, durationMs: 1 } }),
    })
    const t = task({ description: "explore repo", type: "explore" })
    await engine.run(t, { depth: 0, emit: (e) => void events.push(e) })
    expect(events.map((e) => e.type)).toEqual(["subagent_start", "subagent_end"])
    expect(events[0]).toMatchObject({
      subagentId: t.id,
      name: "explore repo",
      prompt: "do it",
      subagentType: "explore",
    })
    expect(events[1]).toMatchObject({ subagentId: t.id, name: "explore repo", result: "hi" })
  })

  it("refuses at depth >= maxDepth with a structured depth_limit_exceeded outcome", async () => {
    const events: TaggedAgentEvent[] = []
    let workerCalls = 0
    const engine = new SubagentEngine({
      runWorker: async () => {
        workerCalls++
        return { text: "", usage: { turns: 0, toolCalls: 0, durationMs: 0 } }
      },
    })
    const outcome = await engine.run(task(), {
      depth: MAX_SUBAGENT_DEPTH,
      emit: (e) => void events.push(e),
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe("depth_limit_exceeded")
    expect(outcome.error?.message).toContain("depth_limit_exceeded")
    expect(outcome.depth).toBe(MAX_SUBAGENT_DEPTH + 1)
    expect(workerCalls).toBe(0)
    expect(events).toHaveLength(0)
  })

  it("lets nested runs pass depth+1 up to the cap", () => {
    const engine = new SubagentEngine({
      runWorker: async () => ({ text: "", usage: { turns: 0, toolCalls: 0, durationMs: 0 } }),
    })
    expect(engine.resolveDepth(0)).toEqual({ depth: 1 })
    expect(engine.resolveDepth(1)).toEqual({ depth: 2 })
    expect(engine.resolveDepth(2)).toEqual({ depth: 3 })
    expect(engine.resolveDepth(MAX_SUBAGENT_DEPTH).failure?.code).toBe("depth_limit_exceeded")
    expect(engine.depthLimit).toBe(MAX_SUBAGENT_DEPTH)
  })

  it("turns worker errors into worker_failed + subagent_fail (no throw)", async () => {
    const events: TaggedAgentEvent[] = []
    const engine = new SubagentEngine({
      runWorker: async () => {
        throw new Error("child exploded")
      },
    })
    const outcome = await engine.run(task(), { depth: 0, emit: (e) => void events.push(e) })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toEqual({ code: "worker_failed", message: "child exploded" })
    expect(events.map((e) => e.type)).toEqual(["subagent_start", "subagent_fail"])
  })

  it("gives every task a fresh, independent worker context", async () => {
    const contexts: WorkerContext[] = []
    const engine = new SubagentEngine({
      runWorker: async (_t, ctx) => {
        contexts.push(ctx)
        return { text: "ok", usage: { turns: 1, toolCalls: 0, durationMs: 1 } }
      },
    })
    // Two sequential runs — contexts must be distinct objects (no shared
    // mutable per-task state inside the engine), each at its own depth.
    const a = await engine.run(task(), { depth: 0 })
    const b = await engine.run(task(), { depth: 1 })
    expect(contexts).toHaveLength(2)
    expect(contexts[0]).not.toBe(contexts[1])
    expect(contexts[0]).toMatchObject({ depth: 1, maxDepth: MAX_SUBAGENT_DEPTH })
    expect(contexts[1]).toMatchObject({ depth: 2, maxDepth: MAX_SUBAGENT_DEPTH })
    expect(a.depth).toBe(1)
    expect(b.depth).toBe(2)
    // Foreground runs never touch the background registry.
    expect(engine.listBackground()).toHaveLength(0)
  })

  it("honors a custom maxDepth", async () => {
    const engine = new SubagentEngine({
      maxDepth: 1,
      runWorker: async () => ({ text: "x", usage: { turns: 0, toolCalls: 0, durationMs: 0 } }),
    })
    expect((await engine.run(task(), { depth: 0 })).ok).toBe(true)
    expect((await engine.run(task(), { depth: 1 })).error?.code).toBe("depth_limit_exceeded")
  })
})

describe("SubagentEngine background", () => {
  const task = (): SubagentTask => createSubagentTask({ description: "bg work", prompt: "later", type: "general" })

  function deferredWorker(): {
    engine: SubagentEngine
    release: (result: WorkerResult) => void
    started: Promise<void>
    contexts: WorkerContext[]
  } {
    let release!: (result: WorkerResult) => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => (markStarted = resolve))
    const contexts: WorkerContext[] = []
    const engine = new SubagentEngine({
      runWorker: (_t, ctx) => {
        contexts.push(ctx)
        markStarted()
        return new Promise<WorkerResult>((resolve) => (release = resolve))
      },
    })
    return { engine, release: (result) => release(result), started, contexts }
  }

  it("returns the id immediately and completes later via awaitBackground", async () => {
    const events: TaggedAgentEvent[] = []
    const { engine, release, started } = deferredWorker()
    const t = task()
    const outcome = engine.startBackground(t, { depth: 0, emit: (e) => void events.push(e) })
    expect(outcome.background).toBe(true)
    expect(outcome.ok).toBe(true)
    expect(outcome.id).toBe(t.id)
    expect(events.map((e) => e.type)).toEqual(["subagent_background_start"])
    expect(engine.getStatus(t.id)?.status).toBe("running")

    await started
    release({ text: "bg result", usage: { turns: 3, toolCalls: 2, durationMs: 40 } })
    const done = await engine.awaitBackground(t.id)
    expect(done.ok).toBe(true)
    expect(done.text).toBe("bg result")
    expect(engine.getStatus(t.id)).toMatchObject({ status: "completed", output: "bg result" })
    expect(engine.usageFor(t.id)).toEqual({ turns: 3, toolCalls: 2, durationMs: 40 })
    expect(events.map((e) => e.type)).toEqual(["subagent_background_start", "subagent_background_end"])
  })

  it("cancelBackground aborts the worker's signal and marks cancelled", async () => {
    const events: TaggedAgentEvent[] = []
    const aborted: boolean[] = []
    const engine = new SubagentEngine({
      runWorker: async (_t, ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.signal?.aborted) resolve()
          else ctx.signal?.addEventListener("abort", () => resolve(), { once: true })
        })
        aborted.push(ctx.signal?.aborted === true)
        return { text: "partial", usage: { turns: 1, toolCalls: 0, durationMs: 1 } }
      },
    })
    const t = task()
    engine.startBackground(t, { depth: 0, emit: (e) => void events.push(e) })
    expect(engine.cancelBackground(t.id)).toBe(true)
    const done = await engine.awaitBackground(t.id)
    expect(aborted).toEqual([true])
    expect(done.ok).toBe(false)
    expect(done.error?.code).toBe("cancelled")
    expect(engine.getStatus(t.id)?.status).toBe("cancelled")
    expect(events.map((e) => e.type)).toEqual(["subagent_background_start", "subagent_background_fail"])
    // Cancelling twice (or an unknown id) is a no-op.
    expect(engine.cancelBackground(t.id)).toBe(false)
    expect(engine.cancelBackground("nope")).toBe(false)
  })

  it("refuses background starts past the depth guard", async () => {
    const engine = new SubagentEngine({
      runWorker: async () => ({ text: "", usage: { turns: 0, toolCalls: 0, durationMs: 0 } }),
    })
    const outcome = engine.startBackground(task(), { depth: MAX_SUBAGENT_DEPTH })
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe("depth_limit_exceeded")
    expect(engine.getStatus(outcome.id)).toBeUndefined()
  })

  it("turns background worker errors into error status + background_fail", async () => {
    const events: TaggedAgentEvent[] = []
    const engine = new SubagentEngine({
      runWorker: async () => {
        throw new Error("bg exploded")
      },
    })
    const t = task()
    engine.startBackground(t, { depth: 0, emit: (e) => void events.push(e) })
    const done = await engine.awaitBackground(t.id)
    expect(done.error).toEqual({ code: "worker_failed", message: "bg exploded" })
    expect(engine.getStatus(t.id)).toMatchObject({ status: "error", error: "bg exploded" })
    expect(events.map((e) => e.type)).toEqual(["subagent_background_start", "subagent_background_fail"])
    expect(await engine.awaitBackground("missing-id")).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    })
  })

  it("lists in-flight and finished background tasks with usage summaries", async () => {
    const { engine, release, started } = deferredWorker()
    const t = task()
    engine.startBackground(t, { depth: 0 })
    const listed = engine.listBackground()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: t.id, depth: 1, status: "running", task: { description: "bg work" } })
    await started
    release({ text: "ok", usage: { turns: 1, toolCalls: 1, durationMs: 2 } })
    await engine.awaitBackground(t.id)
    expect(engine.aggregateUsage()).toEqual({ turns: 1, toolCalls: 1, durationMs: 2 })
    engine.resetUsage()
    expect(engine.aggregateUsage()).toEqual({ turns: 0, toolCalls: 0, durationMs: 0 })
    // Status entry survives completion (kept for reads), usage can be reset.
    expect(engine.getStatus(t.id)?.status).toBe("completed")
  })
})
