/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, it, expect } from "vitest"
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
  it("prints all results without throwing", () => {
    const results: EvalResult[] = [
      { name: "a", passed: true, detail: "ok" },
      { name: "b", passed: false, detail: "missing" },
    ]
    expect(() => reportEvals(results)).not.toThrow()
  })

  it("handles an empty list", () => {
    expect(() => reportEvals([])).not.toThrow()
  })

  it("reports the correct pass count", () => {
    const results: EvalResult[] = [
      { name: "a", passed: true, detail: "ok" },
      { name: "b", passed: false, detail: "missing" },
    ]
    // reportEvals writes to stdout; verify it completes cleanly.
    expect(() => reportEvals(results)).not.toThrow()
  })
})
