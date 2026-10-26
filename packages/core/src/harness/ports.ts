/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Ports: the only way the recursive harness reaches the outside world.
 *
 * The method is model-agnostic and substrate-agnostic. Everything it needs
 * from the host — running one rollout under a candidate harness, and
 * running one file-editing improver session — is an interface here, so the
 * whole recursion is deterministic in tests and re-targetable at another
 * coding agent without touching the method.
 *
 * Adapted from Harness² (Copyright 2026 Google LLC, Apache-2.0) — see
 * NOTICE.md in this directory.
 */

import type { HarnessRun } from "./types.js"

/**
 * One unit of work the agent is asked to do.
 *
 * For a coding agent a task is a user request plus the repository state it
 * lands in: the request is what the user typed, `sourceDir` is the checkout
 * the work happens against, and `domain` is the grouping used by the
 * experience library (a language, an area, a stack).
 */
export interface HarnessTask {
  id: string
  domain: string
  /** The request in the user's own words, verbatim. */
  request: string
  /** A directory of material the task is done from, when there is one. */
  sourceDir?: string
  /** Stable facts about the starting state (branch, failing test, ...). */
  notes?: string
}

/** One rollout: materialise a harness, run the task under it, report what happened. */
export interface HarnessRolloutRequest {
  task: HarnessTask
  /** Stable label inside the mode: `base1`, `inv2`, `agg1`, `c3`. */
  label: string
  /** Globally stable id: `<namespace>/<task>/<label>`. */
  runId: string
  /** The materialised harness, or `null` for the inherited base harness. */
  harnessDir: string | null
  /** Where the rollout writes its artifacts. The engine creates it. */
  runDir: string
}

export interface RolloutPort {
  run(request: HarnessRolloutRequest): Promise<HarnessRun>
}

/** One improver / selector session with file access in an isolated workspace. */
export interface HarnessSessionRequest {
  /** Stable label: `inv1.a1`, `agg2.a1`, `select.agg2`, `experience.agg2`. */
  label: string
  /** The mission, carrying the evidence layout. */
  mission: string
  /** The system prompt for the session, when the host has one. */
  system: string
  /** The workspace root. `context/` lives inside it and is editable. */
  workspace: string
  /** A deadline hint in milliseconds. */
  timeoutMs?: number
}

/**
 * What a session reports back.
 *
 * `text` is the assistant's final message: the engine parses notes, choices
 * and lessons out of it, but the harness itself is read from the files the
 * session edited.
 */
export interface HarnessSessionResult {
  text: string
  ok?: boolean
  costUsd?: number
  wallS?: number
  error?: string
}

export interface SessionPort {
  run(request: HarnessSessionRequest): Promise<HarnessSessionResult>
}

/** Everything the engine is allowed to call. */
export interface RuntimePorts {
  rollout: RolloutPort
  session: SessionPort
}

/**
 * A concurrency limiter.
 *
 * The method runs stages in parallel; a host with a small provider quota
 * still needs the same ORDER of ledger records, so callers use this to cap
 * in-flight work without changing what is recorded.
 */
export function semaphore(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  const width = Math.max(1, Math.trunc(limit))
  let active = 0
  const queue: Array<() => void> = []
  const release = (): void => {
    active--
    const next = queue.shift()
    if (next) next()
  }
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= width) {
      await new Promise<void>((resolve) => queue.push(resolve))
    }
    active++
    try {
      return await task()
    } finally {
      release()
    }
  }
}

/** Run tasks concurrently, preserving input order in the result. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const gate = semaphore(limit)
  return Promise.all(items.map((item, index) => gate(() => task(item, index))))
}
