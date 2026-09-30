/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { MistakeDetector, type MistakeType } from "./mistake-detector.js"

const record = (
  detector: MistakeDetector,
  overrides: { type?: MistakeType; rootCause?: string; fix?: string; error?: string } = {},
) =>
  detector.record({
    task: "run tests",
    action: "npm test",
    observation: "suite failed",
    error: overrides.error ?? "exit code 1",
    type: overrides.type ?? "TESTING_ERROR",
    rootCause: overrides.rootCause ?? "no coverage run",
    fix: overrides.fix ?? "run coverage before merge",
    verification: "tests green",
  })

describe("MistakeDetector", () => {
  it("record() stores the record and stamps id and timestamp", () => {
    const detector = new MistakeDetector()
    const rec = record(detector)
    expect(rec.id.startsWith("mistake_")).toBe(true)
    expect(() => new Date(rec.timestamp).toISOString()).not.toThrow()
    expect(rec.task).toBe("run tests")
    expect(rec.error).toBe("exit code 1")
    expect(record(detector).id).not.toBe(rec.id)
  })

  it("generates the documented prevention rule per mistake type", () => {
    const detector = new MistakeDetector()
    const tool = record(detector, { type: "TOOL_ERROR", rootCause: "bad flag", fix: "check --help" })
    expect(tool.preventionRule).toBe(
      "Check tool availability and arguments before calling. Root cause: bad flag. Fix: check --help",
    )
    const security = record(detector, { type: "SECURITY_ERROR", rootCause: "raw input", fix: "validate" })
    expect(security.preventionRule).toBe(
      "Validate inputs and avoid hardcoded secrets. Root cause: raw input. Fix: validate",
    )
  })

  it("getByType() filters records by type", () => {
    const detector = new MistakeDetector()
    record(detector, { type: "TOOL_ERROR" })
    record(detector, { type: "TOOL_ERROR" })
    record(detector, { type: "SYNTAX_ERROR" })
    expect(detector.getByType("TOOL_ERROR")).toHaveLength(2)
    expect(detector.getByType("SYNTAX_ERROR")).toHaveLength(1)
    expect(detector.getByType("API_ERROR")).toEqual([])
  })

  it("getMostFrequent() returns null for an empty detector and the strict leader otherwise", () => {
    const detector = new MistakeDetector()
    expect(detector.getMostFrequent()).toBeNull()

    record(detector, { type: "TOOL_ERROR" })
    record(detector, { type: "SYNTAX_ERROR" })
    expect(detector.getMostFrequent()).toEqual({ type: "TOOL_ERROR", count: 1 }) // tie → first recorded wins

    record(detector, { type: "SYNTAX_ERROR" })
    record(detector, { type: "SYNTAX_ERROR" })
    expect(detector.getMostFrequent()).toEqual({ type: "SYNTAX_ERROR", count: 3 })
  })

  it("getPreventionRules() deduplicates identical rules", () => {
    const detector = new MistakeDetector()
    record(detector, { type: "TOOL_ERROR", rootCause: "same cause", fix: "same fix" })
    record(detector, { type: "TOOL_ERROR", rootCause: "same cause", fix: "same fix" })
    record(detector, { type: "TOOL_ERROR", rootCause: "other cause", fix: "other fix" })
    expect(detector.getPreventionRules()).toHaveLength(2)
  })
})
