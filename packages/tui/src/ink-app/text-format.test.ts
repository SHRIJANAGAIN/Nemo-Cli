/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/** hardWrapLongRuns: only over-long unbroken runs are touched. */

import { describe, expect, it } from "vitest"
import { hardWrapLongRuns, MAX_UNBROKEN_RUN } from "./text-format.js"

describe("hardWrapLongRuns", () => {
  it("passes ordinary prose byte-identical", () => {
    const prose = "Hi! What proof modify checkbox UDP html? buz repair user capturing overlapping interpreted"
    expect(hardWrapLongRuns(prose)).toBe(prose)
    expect(hardWrapLongRuns("line one\nline two\nline three")).toBe("line one\nline two\nline three")
    expect(hardWrapLongRuns("")).toBe("")
  })

  it("splits runs longer than the bound with real newlines", () => {
    const out = hardWrapLongRuns("A".repeat(2500), 1000)
    expect(out).toBe(`${"A".repeat(1000)}\n${"A".repeat(1000)}\n${"A".repeat(500)}`)
    // Longest measured run is now within the bound.
    for (const run of out.split("\n")) expect(run.length).toBeLessThanOrEqual(1000)
  })

  it("never splits surrogate pairs", () => {
    const out = hardWrapLongRuns("😀".repeat(2500), 1000)
    expect([...out.replace(/\n/g, "")].length).toBe(2500)
    for (const run of out.split("\n")) expect([...run].length).toBeLessThanOrEqual(1000)
  })

  it("leaves runs at exactly the bound untouched", () => {
    const exact = "B".repeat(MAX_UNBROKEN_RUN)
    expect(hardWrapLongRuns(exact)).toBe(exact)
  })
})
