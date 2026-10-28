/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { findReviewersForFiles } from "./specialist-agents.js"

function names(files: string[], diff = ""): string[] {
  return findReviewersForFiles(files, diff, process.cwd()).map((p) => p.name)
}

describe("findReviewersForFiles review dimensions", () => {
  it("always includes the base quality + silent-failure dimensions", () => {
    const n = names(["src/plain.ts"], "const x = 1")
    expect(n).toContain("code-reviewer")
    expect(n).toContain("silent-failure-hunter")
  })

  it("adds the security dimension on credential patterns", () => {
    const n = names(["src/auth.ts"], "const token = req.headers.authorization")
    expect(n).toContain("security-reviewer")
  })

  it("adds the coverage dimension when tests change", () => {
    const n = names(["src/app.test.ts"], "describe('app', () => {})")
    expect(n).toContain("pr-test-analyzer")
  })

  it("adds the coverage dimension when the diff asserts behavior", () => {
    const n = names(["src/app.ts"], "expect(result).toBe(true)")
    expect(n).toContain("pr-test-analyzer")
  })

  it("adds the performance dimension on hot-loop patterns", () => {
    const n = names(["src/list.ts"], "for (let i = 0; i < items.length; i++) { render(items[i]) }")
    expect(n).toContain("performance-optimizer")
  })

  it("never duplicates a dimension", () => {
    const n = names(["src/auth.test.ts"], "token expect(result).toBe(true) N+1 query plan")
    expect(new Set(n).size).toBe(n.length)
  })
})
