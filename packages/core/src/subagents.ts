/* Copyright 2026 SKT AI LABS PRIVATE LIMITED.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Subagents — isolated Task workers with a depth guard and usage summaries.
 *
 * Two layers live here:
 *  - `runSubagent` / `summarizeUsage`: a minimal guarded runner helper for
 *    hosts that only need prompt-in / output-out with a depth check.
 *  - `SubagentEngine`: the orchestration engine (AGENTS.md module map:
 *    "isolated Task workers, depth guard, usage summaries"). Every task runs
 *    through an INJECTED worker — the engine itself NEVER calls a model, so
 *    tests stay deterministic and network-free. Each task gets its own fresh
 *    worker context (fresh session/buffer lives in the worker; the engine
 *    shares no mutable state between tasks), an explicit depth guarded by
 *    `maxDepth` (default MAX_SUBAGENT_DEPTH), and a usage summary. Foreground
 *    runs return a structured outcome; background runs land in an in-flight
 *    registry with getStatus / awaitBackground / cancelBackground, each with
 *    its own AbortController.
 *
 * Lifecycle events are the protocol `subagent_*` events, emitted through the
 * host's AgentEventSink — never redefined here (packages/protocol owns them).
 * IDs come from `crypto.randomUUID()` (no uuid dependency).
 */

import { randomUUID } from "crypto"
import type { AgentEvent, AgentEventSink } from "../../protocol/src/index.js"

export const MAX_SUBAGENT_DEPTH = 3

export interface SubagentRequest {
  prompt: string
  /** Nesting depth of the caller (0 = main loop). */
  depth?: number
  /** Maximum tool calls the worker may consume. */
  maxToolCalls?: number
}

export interface SubagentUsage {
  toolCalls: number
  inputChars: number
  outputChars: number
  depth: number
}

export interface SubagentResult {
  output: string
  usage: SubagentUsage
}

/** Runner supplied by the host (agent loop in prod, stub in tests). */
export type SubagentRunner = (
  req: Required<Pick<SubagentRequest, "prompt">> & Omit<SubagentRequest, "prompt">,
) => Promise<{
  output: string
  toolCalls: number
}>

export class MaxDepthExceeded extends Error {
  readonly code = "depth_limit_exceeded"
  constructor(depth: number) {
    super(`Subagent depth ${depth} exceeds max ${MAX_SUBAGENT_DEPTH}`)
    this.name = "MaxDepthExceeded"
  }
}

export function childDepth(parentDepth: number | undefined): number {
  return (parentDepth ?? 0) + 1
}

export async function runSubagent(runner: SubagentRunner, req: SubagentRequest): Promise<SubagentResult> {
  const depth = childDepth(req.depth)
  if (depth > MAX_SUBAGENT_DEPTH) throw new MaxDepthExceeded(depth)
  const { output, toolCalls } = await runner({ ...req, prompt: req.prompt })
  return {
    output,
    usage: {
      toolCalls,
      inputChars: req.prompt.length,
      outputChars: output.length,
      depth,
    },
  }
}

/** One-line usage summary for transcripts and budget displays. */
export function summarizeUsage(usage: SubagentUsage): string {
  return `depth ${usage.depth}: ${usage.toolCalls} tool calls, ${usage.inputChars}→${usage.outputChars} chars`
}

/* ─────────────────────────── orchestration engine ─────────────────────────── */

/** A delegated unit of work for an isolated Task worker. */
export interface SubagentTask {
  id: string
  description: string
  prompt: string
  type: string
  model?: string
  isolation?: string
  background?: boolean
}

/** Usage accumulated per worker run; summed into an aggregate summary. */
export interface WorkerUsage {
  turns: number
  toolCalls: number
  durationMs: number
  tokensIn?: number
  tokensOut?: number
}

export interface WorkerContext {
  /** Depth THIS worker runs at (1 = first child of the top-level loop). */
  depth: number
  /** Hard nesting cap; workers must propagate depth+1 to their own spawns. */
  maxDepth: number
  /** Aborts when the owning run is aborted or the background task is cancelled. */
  signal?: AbortSignal
  /** Sink for the spawning run — the worker's nested loop streams here. */
  emit?: AgentEventSink
}

export interface WorkerResult {
  text: string
  usage: WorkerUsage
}

/** Runner supplied by the host. The engine performs no model calls itself. */
export type SubagentWorker = (task: SubagentTask, ctx: WorkerContext) => Promise<WorkerResult>

export type SubagentFailureCode = "depth_limit_exceeded" | "worker_failed" | "cancelled" | "not_found"

export interface SubagentFailure {
  code: SubagentFailureCode
  message: string
}

export interface SubagentOutcome {
  id: string
  /** Depth the task would run at (caller depth + 1) — set even when refused. */
  depth: number
  ok: boolean
  background: boolean
  text: string
  usage?: WorkerUsage
  error?: SubagentFailure
}

export interface BackgroundSubagentStatus {
  id: string
  task: SubagentTask
  depth: number
  status: "running" | "completed" | "error" | "cancelled"
  startedAt: number
  completedAt?: number
  output?: string
  error?: string
  usage?: WorkerUsage
}

/** The protocol subagent lifecycle events (packages/protocol owns the shapes). */
type SubagentLifecycleEvent = Extract<AgentEvent, { type: `subagent_${string}` }>

export interface SubagentEngineOptions {
  runWorker: SubagentWorker
  /** Nesting cap for this engine; defaults to MAX_SUBAGENT_DEPTH. */
  maxDepth?: number
  /** Fallback sink when a call does not pass one. */
  emit?: AgentEventSink
  /** Injectable clock (deterministic tests). */
  now?: () => number
}

/** Task factory: fills a `crypto.randomUUID()` id when the caller has none. */
export function createSubagentTask(task: Omit<SubagentTask, "id"> & { id?: string }): SubagentTask {
  return { ...task, id: task.id ?? randomUUID() }
}

/** Aggregate usage across task summaries (tokens only when present). */
export function sumUsage(usages: readonly WorkerUsage[]): WorkerUsage {
  const out: WorkerUsage = { turns: 0, toolCalls: 0, durationMs: 0 }
  for (const u of usages) {
    out.turns += u.turns
    out.toolCalls += u.toolCalls
    out.durationMs += u.durationMs
    if (u.tokensIn !== undefined) out.tokensIn = (out.tokensIn ?? 0) + u.tokensIn
    if (u.tokensOut !== undefined) out.tokensOut = (out.tokensOut ?? 0) + u.tokensOut
  }
  return out
}

/** Human-readable per-task / aggregate usage summary line. */
export function formatWorkerUsage(usage: WorkerUsage): string {
  const tokens =
    usage.tokensIn !== undefined || usage.tokensOut !== undefined
      ? `, tokens ${usage.tokensIn ?? "?"}→${usage.tokensOut ?? "?"}`
      : ""
  return `${usage.turns} turn(s), ${usage.toolCalls} tool call(s), ${usage.durationMs}ms${tokens}`
}

interface BackgroundRecord {
  /** Live status object — mutated as the task progresses. */
  readonly status: BackgroundSubagentStatus
  readonly controller: AbortController
  readonly emit?: AgentEventSink
  readonly done: Promise<SubagentOutcome>
}

/** Finished background entries beyond this count are pruned (oldest first). */
const MAX_BACKGROUND_HISTORY = 50

export class SubagentEngine {
  private readonly runWorker: SubagentWorker
  private readonly maxDepth: number
  private readonly defaultEmit?: AgentEventSink
  private readonly now: () => number
  private readonly background: Map<string, BackgroundRecord> = new Map()
  private readonly usageById: Map<string, WorkerUsage> = new Map()

  constructor(options: SubagentEngineOptions) {
    this.runWorker = options.runWorker
    this.maxDepth = options.maxDepth ?? MAX_SUBAGENT_DEPTH
    this.defaultEmit = options.emit
    this.now = options.now ?? ((): number => Date.now())
  }

  /** Effective nesting cap for this engine. */
  get depthLimit(): number {
    return this.maxDepth
  }

  /**
   * Depth guard. A caller at `parentDepth` spawns at `parentDepth + 1`;
   * at or past `maxDepth` the spawn is refused with a structured
   * `depth_limit_exceeded` failure — never unbounded nesting.
   */
  resolveDepth(parentDepth: number | undefined): { depth: number; failure?: SubagentFailure } {
    const parent = parentDepth ?? 0
    const depth = parent + 1
    if (parent >= this.maxDepth) {
      return {
        depth,
        failure: {
          code: "depth_limit_exceeded",
          message: `depth_limit_exceeded: caller at depth ${parent} is at or past the max subagent depth (${this.maxDepth})`,
        },
      }
    }
    return { depth }
  }

  /**
   * Foreground run: depth guard → subagent_start → worker → subagent_end.
   * Returns a structured outcome; worker errors become `worker_failed`
   * (with subagent_fail emitted) instead of throwing.
   */
  async run(
    task: SubagentTask,
    opts: { depth?: number; signal?: AbortSignal; emit?: AgentEventSink } = {},
  ): Promise<SubagentOutcome> {
    const emit = opts.emit ?? this.defaultEmit
    const { depth, failure } = this.resolveDepth(opts.depth)
    if (failure) return { id: task.id, depth, ok: false, background: false, text: "", error: failure }
    await emit?.({
      type: "subagent_start",
      subagentId: task.id,
      name: task.description,
      prompt: task.prompt,
      subagentType: task.type,
      isolation: task.isolation,
    })
    try {
      const result = await this.runWorker(task, {
        depth,
        maxDepth: this.maxDepth,
        signal: opts.signal,
        emit,
      })
      this.usageById.set(task.id, result.usage)
      await emit?.({ type: "subagent_end", subagentId: task.id, name: task.description, result: result.text })
      return { id: task.id, depth, ok: true, background: false, text: result.text, usage: result.usage }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await emit?.({ type: "subagent_fail", subagentId: task.id, name: task.description, error: message })
      return {
        id: task.id,
        depth,
        ok: false,
        background: false,
        text: "",
        error: { code: "worker_failed", message },
      }
    }
  }

  /**
   * Background mode: registers the task and returns its id IMMEDIATELY; the
   * worker runs detached behind its own AbortController and later emits
   * subagent_background_end (or _fail). The depth guard applies before start.
   */
  startBackground(task: SubagentTask, opts: { depth?: number; emit?: AgentEventSink } = {}): SubagentOutcome {
    const emit = opts.emit ?? this.defaultEmit
    const { depth, failure } = this.resolveDepth(opts.depth)
    if (failure) return { id: task.id, depth, ok: false, background: true, text: "", error: failure }

    const controller = new AbortController()
    const status: BackgroundSubagentStatus = {
      id: task.id,
      task,
      depth,
      status: "running",
      startedAt: this.now(),
    }
    // Build the completion promise BEFORE registering: the worker's first
    // suspension point happens after the map insert below, so observers
    // always see the registry entry first.
    const done: Promise<SubagentOutcome> = this.driveBackground(task, depth, controller, status, emit)
    this.background.set(task.id, { status, controller, emit, done })
    this.pruneBackground()
    this.fireEmit(emit, {
      type: "subagent_background_start",
      subagentId: task.id,
      name: task.description,
      prompt: task.prompt,
      subagentType: task.type,
      isolation: task.isolation,
    })
    return { id: task.id, depth, ok: true, background: true, text: "" }
  }

  getStatus(id: string): BackgroundSubagentStatus | undefined {
    return this.background.get(id)?.status
  }

  listBackground(): BackgroundSubagentStatus[] {
    return Array.from(this.background.values(), (record) => record.status)
  }

  /** Await a background task's structured outcome (`not_found` when unknown). */
  awaitBackground(id: string): Promise<SubagentOutcome> {
    const record = this.background.get(id)
    if (record) return record.done
    return Promise.resolve({
      id,
      depth: 0,
      ok: false,
      background: true,
      text: "",
      error: { code: "not_found", message: `no background subagent ${id}` },
    })
  }

  /** Abort a running background task through its AbortController. */
  cancelBackground(id: string): boolean {
    const record = this.background.get(id)
    if (!record || record.status.status !== "running") return false
    record.controller.abort()
    return true
  }

  /** Usage recorded for one task (foreground or background). */
  usageFor(id: string): WorkerUsage | undefined {
    return this.usageById.get(id)
  }

  /** Aggregate usage summary across every completed task. */
  aggregateUsage(): WorkerUsage {
    return sumUsage(Array.from(this.usageById.values()))
  }

  resetUsage(): void {
    this.usageById.clear()
  }

  private async driveBackground(
    task: SubagentTask,
    depth: number,
    controller: AbortController,
    status: BackgroundSubagentStatus,
    emit: AgentEventSink | undefined,
  ): Promise<SubagentOutcome> {
    try {
      const result = await this.runWorker(task, {
        depth,
        maxDepth: this.maxDepth,
        signal: controller.signal,
        emit,
      })
      this.usageById.set(task.id, result.usage)
      status.completedAt = this.now()
      status.output = result.text
      status.usage = result.usage
      if (controller.signal.aborted) {
        status.status = "cancelled"
        status.error = "cancelled"
        this.fireEmit(emit, {
          type: "subagent_background_fail",
          subagentId: task.id,
          name: task.description,
          error: "cancelled",
        })
        return {
          id: task.id,
          depth,
          ok: false,
          background: true,
          text: result.text,
          usage: result.usage,
          error: { code: "cancelled", message: "cancelled" },
        }
      }
      status.status = "completed"
      this.fireEmit(emit, {
        type: "subagent_background_end",
        subagentId: task.id,
        name: task.description,
        result: result.text,
      })
      return { id: task.id, depth, ok: true, background: true, text: result.text, usage: result.usage }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const cancelled = controller.signal.aborted
      status.completedAt = this.now()
      status.status = cancelled ? "cancelled" : "error"
      status.error = cancelled ? "cancelled" : message
      this.fireEmit(emit, {
        type: "subagent_background_fail",
        subagentId: task.id,
        name: task.description,
        error: message,
      })
      return {
        id: task.id,
        depth,
        ok: false,
        background: true,
        text: "",
        error: { code: cancelled ? "cancelled" : "worker_failed", message },
      }
    }
  }

  /**
   * Event sinks are observers: fire them without letting a throwing sink
   * break orchestration. The sink is invoked synchronously; rejections are
   * swallowed.
   */
  private fireEmit(sink: AgentEventSink | undefined, event: SubagentLifecycleEvent): void {
    if (!sink) return
    void (async () => {
      try {
        await sink(event)
      } catch {
        /* never fail orchestration on an observer */
      }
    })()
  }

  /** Cap finished background entries (running tasks are never dropped). */
  private pruneBackground(): void {
    if (this.background.size <= MAX_BACKGROUND_HISTORY) return
    const finished = Array.from(this.background.values())
      .filter((record) => record.status.status !== "running")
      .sort((a, b) => (a.status.completedAt ?? a.status.startedAt) - (b.status.completedAt ?? b.status.startedAt))
    let excess = this.background.size - MAX_BACKGROUND_HISTORY
    for (const record of finished) {
      if (excess <= 0) break
      this.background.delete(record.status.id)
      excess--
    }
  }
}
