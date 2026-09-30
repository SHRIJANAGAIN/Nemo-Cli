/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, it, expect, vi } from "vitest"
import { reportEvals, type EvalResult, type EvalTask } from "./index.js"

describe("EvalTask / EvalResult types", () => {
  it("defines a valid task shape", () => {
    const task: EvalTask = { name: "greeting", prompt: "Say hello", expect: "hello" }
    expect(task.name).toBe("greeting")
    expect(task.expect).toBe("hello")
  })

  it("defines a valid result shape", () => {
    const result: EvalResult = { name: "greeting", passed: true, detail: "ok" }
    expect(result.passed).toBe(true)
    expect(result.detail).toBe("ok")
  })
})

describe("reportEvals", () => {
  /** Run reportEvals with stdout captured. Writing the fixture to the real
   *  stdout made every suite run print a literal `FAIL  b  (missing)` line —
   *  readers (and log-grepping CI) took it for a vitest failure. */
  const captureReport = (results: EvalResult[]): string => {
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
    const results: EvalResult[] = [
      { name: "a", passed: true, detail: "ok" },
      { name: "b", passed: false, detail: "missing" },
    ]
    const out = captureReport(results)
    expect(out).toContain("PASS  a  (ok)")
    expect(out).toContain("FAIL  b  (missing)")
  })

  it("handles an empty list", () => {
    const out = captureReport([])
    expect(out).toContain("0/0 passed")
  })

  it("reports the correct pass count", () => {
    const results: EvalResult[] = [
      { name: "a", passed: true, detail: "ok" },
      { name: "b", passed: false, detail: "missing" },
    ]
    const out = captureReport(results)
    expect(out).toContain("1/2 passed")
  })
})
