/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Eval task/result types.
 *
 * A task names a prompt, a set of ASSERTIONS about the resulting transcript,
 * and an optional fixture the harness hands to the fake provider. Assertions
 * are data, not closures over test internals, so a task file stays data: it
 * can be loaded from JSON, diffed in review, and printed in a report without
 * executing anything.
 */

/** One scripted turn from the fixture provider. */
export interface ScriptedTurn {
  /** Assistant text. Mutually exclusive with `toolCall`. */
  text?: string
  /** Tool the model "calls" this turn. */
  toolCall?: { name: string; args?: Record<string, unknown> }
  /** Stop reason reported to the loop. Defaults to the natural one. */
  stopReason?: "end_turn" | "tool_use" | "length" | "error" | "aborted"
}

/** Tool the harness runs in place of a real one, recording the call. */
export interface FixtureTool {
  name: string
  /** Result text handed back to the model. */
  result?: string
  isError?: boolean
}

export interface EvalTask {
  name: string
  prompt: string
  /** What must hold about the transcript for this task to pass. */
  assertions: Assertion[]
  /**
   * Turn script for the fake provider. Consumed by call order; the LAST entry
   * repeats once the script is exhausted so a loop that keeps calling tools
   * terminates instead of hanging on an exhausted provider.
   */
  turns?: ScriptedTurn[]
  /** Tools the harness exposes to the fixture model. */
  tools?: FixtureTool[]
  /** Skip with a reason instead of running (documents known-broken tasks). */
  skip?: string
  /** Free-form grouping label used by the report. */
  group?: string
}

export type Assertion =
  | { kind: "assistant-contains"; value: string; caseSensitive?: boolean }
  | { kind: "assistant-matches"; value: string; flags?: string }
  | { kind: "assistant-lacks"; value: string; caseSensitive?: boolean }
  | { kind: "tool-called"; name: string; times?: number }
  | { kind: "tool-not-called"; name: string }
  | { kind: "tool-error"; name: string }
  | { kind: "provider-calls"; value: number }
  | { kind: "turn-count"; value: number }
  | { kind: "session-contains"; role: "user" | "assistant" | "tool"; value: string }
  | { kind: "event-emitted"; type: string }
  | { kind: "event-absent"; type: string }
  | { kind: "custom"; name: string; value: string }

/** Flattened view of one run, used by every assertion kind. */
export interface RunTranscript {
  /** Assistant text per assistant turn, in order. */
  assistantTexts: string[]
  /** Tool names per tool call, in order. */
  toolCalls: string[]
  /** Tool names whose execution reported an error. */
  erroredTools: string[]
  /** Every message role in session order. */
  roles: string[]
  /** Concatenated text of each role class. */
  byRole: Record<"user" | "assistant" | "tool", string>
  /** Provider chat invocations. */
  providerCalls: number
  /** Every emitted AgentEvent type, in order. */
  eventTypes: string[]
  /** Turns the loop completed (one per assistant response). */
  turns: number
  /** Thrown error, if the run failed instead of completing. */
  error?: string
}

export interface AssertionOutcome {
  assertion: Assertion
  passed: boolean
  /** Why it failed, in one line. Empty when passed. */
  detail: string
}

export interface EvalResult {
  name: string
  group?: string
  status: "passed" | "failed" | "skipped"
  /** Every assertion outcome, in declaration order. */
  outcomes: AssertionOutcome[]
  skipReason?: string
  /** Wall-clock duration. Injected clock means 0 in deterministic runs. */
  durationMs: number
  /** Non-fatal harness problems (missing fixture turn, bad assertion). */
  errors: string[]
}

export interface EvalSuiteResult {
  results: EvalResult[]
  passed: number
  failed: number
  skipped: number
  durationMs: number
}

export function emptyTranscript(): RunTranscript {
  return {
    assistantTexts: [],
    toolCalls: [],
    erroredTools: [],
    roles: [],
    byRole: { user: "", assistant: "", tool: "" },
    providerCalls: 0,
    eventTypes: [],
    turns: 0,
  }
}