/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * @shrijan/evals — deterministic behavioural eval harness.
 *
 * Replaces the previous substring-only stub, which called the real agent with
 * the ambient provider: it needed credentials, cost money per run, and returned
 * a different transcript every time, so a suite's own flakiness had to be told
 * apart from a regression. This harness injects a scripted provider and
 * in-memory tools, so a task is pure data and a run is reproducible.
 */

export {
  emptyTranscript,
  type Assertion,
  type AssertionOutcome,
  type EvalResult,
  type EvalSuiteResult,
  type EvalTask,
  type FixtureTool,
  type RunTranscript,
  type ScriptedTurn,
} from "./types.js"

export {
  evaluateAll,
  evaluateAssertion,
  contains,
  countOccurrences,
} from "./assertions.js"

export {
  buildTranscript,
  evalConfig,
  evaluateTask,
  makeFixtureTools,
  makeScriptedProvider,
  runSuite,
  runTask,
  type RunOptions,
} from "./harness.js"

/**
 * Legacy row printer.
 *
 * Kept byte-compatible with the previous stub (`PASS  <name>  (<detail>)` then
 * `N/M passed`) because the original test exists for a real reason: writing a
 * literal `FAIL  b  (missing)` line to the real stdout during a suite run made
 * log-grepping CI read it as a vitest failure. Callers that print should prefer
 * {@link formatSuite}, which returns a string and lets the caller decide where
 * it goes; this exists so an existing caller keeps its exact output.
 */
export function reportEvals(results: readonly LegacyEvalResult[]): void {
  for (const r of results) {
    process.stdout.write(`${r.passed ? "PASS" : "FAIL"}  ${r.name}  (${r.detail})\n`)
  }
  const failed = results.filter((r) => !r.passed).length
  process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`)
}

export {
  buildRegressionReport,
  captureBaseline,
  compareBaseline,
  describeAssertion,
  fingerprint,
  formatDrift,
  formatResult,
  formatSuite,
  formatSuiteJson,
  type Baseline,
  type BaselineDrift,
  type BaselineDriftKind,
  type BaselineEntry,
  type RegressionReport,
  type ReportOptions,
} from "./report.js"

// Imported as TYPES only: the legacy helpers below reference EvalTask/EvalResult
// in signatures, and the `export … from "./types.js"` re-export above does not
// bring the local names into scope (a re-export binds the module's export map,
// not this file's lexical bindings).
import type { EvalResult, EvalTask } from "./types.js"

/* ─────────────────────── compatibility surface ─────────────────────── */

/** Legacy task shape: a bare prompt plus an expected substring. */
export interface LegacyEvalTask {
  name: string
  prompt: string
  expect: string
}

export interface LegacyEvalResult {
  name: string
  passed: boolean
  detail: string
}

/**
 * Adapt a legacy task to the assertion form.
 *
 * Kept so an existing caller keeps working, but it is deliberately WEAK and says
 * so: a single substring over the concatenated transcript passes even when the
 * agent got there by calling the wrong tool. New tasks should declare explicit
 * assertions instead.
 */
export function fromLegacyTask(task: LegacyEvalTask, group?: string): EvalTask {
  return {
    name: task.name,
    prompt: task.prompt,
    ...(group === undefined ? {} : { group }),
    assertions: [{ kind: "assistant-contains", value: task.expect }],
  }
}

/** Summarize results as the legacy `{name, passed, detail}` rows. */
export function toLegacyResults(results: readonly EvalResult[]): LegacyEvalResult[] {
  return results.map((r) => {
    if (r.status === "skipped") {
      return { name: r.name, passed: false, detail: `skipped: ${r.skipReason ?? "no reason"}` }
    }
    const failures = r.outcomes.filter((o) => !o.passed)
    return {
      name: r.name,
      passed: r.status === "passed",
      detail:
        failures.length > 0
          ? failures.map((f) => f.detail).join("; ")
          : r.errors.length > 0
            ? r.errors.join("; ")
            : "ok",
    }
  })
}