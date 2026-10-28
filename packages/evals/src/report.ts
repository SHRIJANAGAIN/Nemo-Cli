/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Suite reporting and baseline comparison.
 *
 * A green suite is only half the signal: the dangerous eval outcome is a
 * SILENT regression where a task keeps passing but stops exercising the thing
 * it was written for. `captureBaseline` records the observable fingerprint of
 * each task (provider calls, tool calls, turn count, assistant text) so
 * `compareBaseline` can name the exact task whose BEHAVIOUR changed even when it
 * still passes. That is the difference between "37/37 passed" and "37/37 passed,
 * and 3 of them stopped calling the tool they exist to test".
 */

import { evaluateAll } from "./assertions.js"
import type { EvalResult, EvalSuiteResult, EvalTask, RunTranscript } from "./types.js"

/* ─────────────────────────────── formatting ──────────────────────────────── */

const GREEN = "[32m"
const RED = "[31m"
const YELLOW = "[33m"
const DIM = "[2m"
const RESET = "[0m"

function colorize(code: string, text: string, enabled: boolean): string {
  return enabled ? `${code}${text}${RESET}` : text
}

export interface ReportOptions {
  color?: boolean
  /** Print one line per task. Default true. */
  verbose?: boolean
}

/** Human-readable suite report. */
export function formatSuite(suite: EvalSuiteResult, opts: ReportOptions = {}): string {
  const color = opts.color === true
  const verbose = opts.verbose !== false
  const lines: string[] = []
  for (const result of suite.results) {
    if (!verbose) continue
    lines.push(formatResult(result, color))
  }
  const summary =
    `${suite.passed} passed, ${suite.failed} failed, ${suite.skipped} skipped` +
    ` (${suite.durationMs}ms)`
  lines.push(
    colorize(suite.failed > 0 ? RED : GREEN, summary, color),
  )
  return lines.join("\n")
}

export function formatResult(result: EvalResult, color = false): string {
  const badge =
    result.status === "passed"
      ? colorize(GREEN, "PASS", color)
      : result.status === "skipped"
        ? colorize(YELLOW, "SKIP", color)
        : colorize(RED, "FAIL", color)
  const group = result.group ? colorize(DIM, `[${result.group}]`, color) : ""
  let line = `${badge}  ${group}${result.name}`
  if (result.status === "skipped") {
    line += colorize(DIM, `  (${result.skipReason ?? "no reason"})`, color)
  }
  for (const error of result.errors) {
    line += `\n      ${colorize(RED, `error: ${error}`, color)}`
  }
  for (const outcome of result.outcomes) {
    if (outcome.passed) continue
    line += `\n      ${colorize(RED, `x ${describeAssertion(outcome.assertion.kind)}: ${outcome.detail}`, color)}`
  }
  return line
}

/** Short label for an assertion kind, used in report lines. */
export function describeAssertion(kind: string): string {
  switch (kind) {
    case "assistant-contains":
      return "assistant contains"
    case "assistant-matches":
      return "assistant matches"
    case "assistant-lacks":
      return "assistant lacks"
    case "tool-called":
      return "tool called"
    case "tool-not-called":
      return "tool not called"
    case "tool-error":
      return "tool errored"
    case "provider-calls":
      return "provider call count"
    case "turn-count":
      return "turn count"
    case "session-contains":
      return "session contains"
    case "event-emitted":
      return "event emitted"
    case "event-absent":
      return "event absent"
    default:
      return String(kind)
  }
}

/** Machine-readable suite result. */
export function formatSuiteJson(suite: EvalSuiteResult): string {
  return JSON.stringify(suite, null, 2)
}

/* ──────────────────────────────── baseline ───────────────────────────────── */

/**
 * The observable fingerprint of one run. Deliberately behaviour, not assertions:
 * the question a baseline answers is "did the agent still DO the thing", not
 * "did the expectations file still evaluate the same way".
 */
export interface BaselineEntry {
  providerCalls: number
  turns: number
  toolCalls: string[]
  erroredTools: string[]
  /** Assistant text per turn, capped so a verbose model cannot bloat the file. */
  assistantTexts: string[]
}

const MAX_BASELINE_TEXT = 400

function cap(text: string): string {
  return text.length <= MAX_BASELINE_TEXT ? text : `${text.slice(0, MAX_BASELINE_TEXT)}…`
}

export function fingerprint(t: RunTranscript): BaselineEntry {
  return {
    providerCalls: t.providerCalls,
    turns: t.turns,
    toolCalls: [...t.toolCalls],
    erroredTools: [...t.erroredTools],
    assistantTexts: t.assistantTexts.map(cap),
  }
}

export interface Baseline {
  version: 1
  tasks: Record<string, BaselineEntry>
}

/** Build a baseline from freshly-run transcripts, keyed by task name. */
export function captureBaseline(entries: readonly { name: string; transcript: RunTranscript }[]): Baseline {
  const tasks: Record<string, BaselineEntry> = {}
  for (const { name, transcript } of entries) {
    tasks[name] = fingerprint(transcript)
  }
  return { version: 1, tasks }
}

export type BaselineDriftKind = "added" | "removed" | "changed"

export interface BaselineDrift {
  task: string
  kind: BaselineDriftKind
  /** Field-level differences for `changed`. */
  fields: string[]
}

/** Compare two baselines, naming every task whose behaviour moved. */
export function compareBaseline(before: Baseline, after: Baseline): BaselineDrift[] {
  const drifts: BaselineDrift[] = []
  for (const name of Object.keys(after.tasks)) {
    const prior = before.tasks[name]
    if (!prior) {
      drifts.push({ task: name, kind: "added", fields: [] })
      continue
    }
    const fields = diffEntry(prior, after.tasks[name]!)
    if (fields.length > 0) drifts.push({ task: name, kind: "changed", fields })
  }
  for (const name of Object.keys(before.tasks)) {
    if (!after.tasks[name]) drifts.push({ task: name, kind: "removed", fields: [] })
  }
  return drifts
}

function diffEntry(a: BaselineEntry, b: BaselineEntry): string[] {
  const fields: string[] = []
  if (a.providerCalls !== b.providerCalls) {
    fields.push(`providerCalls ${a.providerCalls}→${b.providerCalls}`)
  }
  if (a.turns !== b.turns) {
    fields.push(`turns ${a.turns}→${b.turns}`)
  }
  const toolsBefore = a.toolCalls.join(",")
  const toolsAfter = b.toolCalls.join(",")
  if (toolsBefore !== toolsAfter) fields.push(`toolCalls [${toolsBefore}]→[${toolsAfter}]`)
  const errBefore = a.erroredTools.join(",")
  const errAfter = b.erroredTools.join(",")
  if (errBefore !== errAfter) fields.push(`erroredTools [${errBefore}]→[${errAfter}]`)
  const textBefore = a.assistantTexts.join("\n")
  const textAfter = b.assistantTexts.join("\n")
  if (textBefore !== textAfter) fields.push("assistantTexts changed")
  return fields
}

/**
 * Re-run the suite against a stored baseline.
 *
 * Drift is REPORTED, not failed on: a behaviour change is often intentional
 * (a task was legitimately fixed) and the human decides. What is returned is
 * the evidence needed to make that decision.
 */
export interface RegressionReport {
  suite: EvalSuiteResult
  drift: BaselineDrift[]
  /** Tasks that pass but whose behaviour drifted — the silent-regression set. */
  suspicious: string[]
}

export function buildRegressionReport(
  suite: EvalSuiteResult,
  before: Baseline,
  transcripts: ReadonlyMap<string, RunTranscript>,
): RegressionReport {
  const entries = [...transcripts.entries()].map(([name, transcript]) => ({ name, transcript }))
  const drift = compareBaseline(before, captureBaseline(entries))
  const passedNames = new Set(
    suite.results.filter((r) => r.status === "passed").map((r) => r.name),
  )
  const suspicious = drift
    .filter((d) => d.kind === "changed" && passedNames.has(d.task))
    .map((d) => d.task)
  return { suite, drift, suspicious }
}

/** Convenience: format drift for a terminal. */
export function formatDrift(
  drifts: readonly BaselineDrift[],
  /*colorize the kind labels*/ color = false,
): string {
  if (drifts.length === 0) return colorize(GREEN, "baseline: no drift", color)
  return drifts
    .map((d) => {
      const label =
        d.kind === "added"
          ? "added"
          : d.kind === "removed"
            ? "removed"
            : `changed (${d.fields.join("; ")})`
      return `  ${colorize(YELLOW, d.kind.toUpperCase(), color)} ${d.task}: ${label}`
    })
    .join("\n")
}

export { evaluateAll }