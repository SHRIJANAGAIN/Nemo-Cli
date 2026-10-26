/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * `exec` is the CI-facing command: `nemo exec "..." | tee log` inside a
 * pipeline. It used to exit 0 unconditionally, so a run in which policy refused
 * every tool call — or one the rollout budget cut short — reported success to
 * the shell while having accomplished nothing.
 *
 * `EXIT_DENIED` already existed for precisely that ("the check ran fine, the
 * answer is no — CI-gatable"); only the agent path never consulted it.
 *
 * These cases pin BOTH directions, which is the whole risk of the change: the
 * codes must fire on a genuinely fruitless run, and must stay silent on an
 * ordinary one. A test that only asserted the first half would pass just as
 * happily against an implementation that failed every pipeline.
 */

import { describe, expect, it } from "vitest"
import { EXIT_DENIED, EXIT_ERROR } from "../command-registry.js"
import { NO_RUN_SIGNALS, exitCodeForSignals, recordRunSignal, type RunSignalEvent, type RunSignals } from "./exec.js"

/**
 * Stand-in for a real agent event, typed structurally rather than as
 * `TaggedAgentEvent` because `apps/cli` may not import `packages/protocol`
 * (`nemo/no-cross-package-import`). Every field the reducer reads is real,
 * so it sees exactly what the loop emits.
 */
function event(fields: RunSignalEvent): RunSignalEvent {
  return fields
}

/** Fold a whole event stream, the way execCommand's sink does. */
function fold(...events: RunSignalEvent[]): RunSignals {
  return events.reduce<RunSignals>(recordRunSignal, NO_RUN_SIGNALS)
}

const deny = event({ type: "permission_response", allowed: false })
const allow = { type: "permission_response", id: "1", allowed: true } as RunSignalEvent

describe("exitCodeForSignals", () => {
  it("leaves a clean run alone", () => {
    expect(exitCodeForSignals(NO_RUN_SIGNALS)).toBeUndefined()
  })

  it("reports EXIT_DENIED when policy refused everything and permitted nothing", () => {
    // Nothing was permitted, so nothing could have been accomplished.
    expect(exitCodeForSignals(fold(deny, deny))).toBe(EXIT_DENIED)
    expect(EXIT_DENIED).toBe(3)
  })

  it("reports EXIT_ERROR when the rollout budget cut the loop short", () => {
    const signals = fold(allow, { type: "budget_exhausted", used: 10, max: 10, remaining: 0 } as RunSignalEvent)
    expect(exitCodeForSignals(signals)).toBe(EXIT_ERROR)
    // Budget exhaustion outranks a partial denial: the run stopped early.
    expect(exitCodeForSignals({ ...signals, denied: 2, allowed: 0 })).toBe(EXIT_ERROR)
  })

  it("reports EXIT_ERROR when the loop's own verification failed", () => {
    const failed = {
      type: "verification_end",
      passed: false,
      steps: [{ name: "lint", status: "fail" as const, detail: "2 errors" }],
    } as RunSignalEvent
    expect(exitCodeForSignals(fold(allow, failed))).toBe(EXIT_ERROR)
  })
})

describe("exitCodeForSignals does not fail ordinary runs", () => {
  it("stays silent when one call was refused but others were permitted", () => {
    // A single refusal inside a productive run is a normal conversational turn.
    expect(exitCodeForSignals(fold(allow, deny, allow))).toBeUndefined()
  })

  it("stays silent on a degraded-but-progressing run", () => {
    const signals = fold(
      allow,
      { type: "mcp_fail", serverName: "docs", error: "spawn ENOENT" } as RunSignalEvent,
      { type: "subagent_fail", subagentId: "s1", name: "tests", error: "boom" } as RunSignalEvent,
      { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: true } as RunSignalEvent,
    )
    expect(exitCodeForSignals(signals)).toBeUndefined()
  })

  it("stays silent on a long healthy run with many successes", () => {
    const events: RunSignalEvent[] = []
    for (let i = 0; i < 50; i += 1) {
      events.push({ type: "permission_response", id: String(i), allowed: true } as RunSignalEvent)
      events.push({
        type: "tool_execution_end",
        toolCallId: `t${i}`,
        toolName: "bash",
        result: {},
        isError: false,
      } as RunSignalEvent)
    }
    events.push({ type: "agent_end", messages: [] } as RunSignalEvent)
    expect(exitCodeForSignals(fold(...events))).toBeUndefined()
  })

  it("ignores a passing verification", () => {
    const passed = {
      type: "verification_end",
      passed: true,
      steps: [{ name: "lint", status: "pass" as const }],
    } as RunSignalEvent
    expect(exitCodeForSignals(fold(allow, passed))).toBeUndefined()
  })
})

describe("recordRunSignal", () => {
  it("counts denials and permissions separately", () => {
    const signals = fold(deny, allow, deny, deny)
    expect(signals.denied).toBe(3)
    expect(signals.allowed).toBe(1)
  })

  it("is a no-op for every other event type", () => {
    const noise = [
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "thinking", thinking: "hmm" },
      {
        type: "compaction",
        removedMessages: 1,
        prunedToolOutputs: 0,
        freedTokens: 10,
        estimatedBefore: 1,
        estimatedAfter: 1,
      },
      { type: "agent_end", messages: [] },
    ] as RunSignalEvent[]
    expect(fold(...noise)).toEqual(NO_RUN_SIGNALS)
  })

  it("does not mutate the signals it is handed", () => {
    const before: RunSignals = { ...NO_RUN_SIGNALS }
    recordRunSignal(before, deny)
    expect(before).toEqual(NO_RUN_SIGNALS)
  })
})
