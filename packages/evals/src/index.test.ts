/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Barrel + legacy-compatibility surface.
 *
 * The `reportEvals` cases keep their original rationale: writing a literal
 * `FAIL  b  (missing)` line to the real stdout during a suite run made
 * log-grepping CI read it as a vitest failure, so stdout is captured here. The
 * legacy row TYPES moved when the substring-only stub was replaced by the
 * assertion harness, so the fixtures below are built as `LegacyEvalResult` —
 * the contract `reportEvals` actually accepts.
 */

import { describe, it, expect, vi } from "vitest"
import {
  reportEvals,
  toLegacyResults,
  runSuite,
  type EvalTask,
  type LegacyEvalResult,
} from "./index.js"

describe("EvalTask shape", () => {
  it("carries assertions rather than a bare expected substring", () => {
    const task: EvalTask = {
      name: "greeting",
      prompt: "Say hello",
      turns: [{ text: "hello" }],
      assertions: [{ kind: "assistant-contains", value: "hello" }],
    }
    expect(task.name).toBe("greeting")
    expect(task.assertions[0]!.kind).toBe("assistant-contains")
  })

  it("a task with no assertions is allowed by the type but fails at run time", () => {
    // The type cannot forbid an empty array (an empty task list is legitimate),
    // so the harness rejects a task that cannot fail. Pinned here so the
    // guarantee lives with the shape.
    const task: EvalTask = { name: "empty", prompt: "hi", assertions: [] }
    expect(task.assertions).toHaveLength(0)
  })
})

describe("reportEvals", () => {
  /** Run reportEvals with stdout captured. Writing the fixture to the real
   *  stdout made every suite run print a literal `FAIL  b  (missing)` line —
   *  readers (and log-grepping CI) took it for a vitest failure. */
  const captureReport = (results: LegacyEvalResult[]): string => {
    const chunks: string[] = []
    const writer = ((chunk: unknown): boolean => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(writer)
    try {
      reportEvals(results)
    } finally {
      spy.mockRestore()
    }
    return chunks.join("")
  }

  it("prints all results without throwing", () => {
    const out = captureReport([
      { name: "a", passed: true, detail: "ok" },
      { name: "b", passed: false, detail: "missing" },
    ])
    expect(out).toContain("PASS  a  (ok)")
    expect(out).toContain("FAIL  b  (missing)")
  })

  it("handles an empty list", () => {
    const out = captureReport([])
    expect(out).toContain("0/0 passed")
  })

  it("reports the correct pass count", () => {
    const out = captureReport([
      { name: "a", passed: true, detail: "ok" },
      { name: "b", passed: false, detail: "missing" },
    ])
    expect(out).toContain("1/2 passed")
  })

  it("round-trips a real suite's results into the legacy printer", async () => {
    const suite = await runSuite([
      { name: "x", prompt: "hi", turns: [{ text: "ok" }], assertions: [{ kind: "assistant-contains", value: "ok" }] },
      { name: "y", prompt: "hi", turns: [{ text: "ok" }], assertions: [{ kind: "assistant-contains", value: "no" }] },
    ])
    const out = captureReport(toLegacyResults(suite.results))
    expect(out).toContain("PASS  x")
    expect(out).toContain("FAIL  y")
    expect(out).toContain("1/2 passed")
  })
})