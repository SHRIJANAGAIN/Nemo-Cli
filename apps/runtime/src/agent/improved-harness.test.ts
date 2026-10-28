/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import {
  composeHarnessBlock,
  loadImprovedHarnessBlock,
  resetImprovedHarnessCacheForTests,
} from "./improved-harness.js"

function emptyHome(): string {
  return mkdtempSync(join(tmpdir(), "improved-harness-"))
}

function homeWithHarness(): string {
  const home = emptyHome()
  const root = join(home, ".nemo", "harness")
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "systemprompt.md"), "Search before writing; verify before claiming.\n", "utf8")
  writeFileSync(join(root, "guardrails.md"), "- Never delete a branch without asking.\n", "utf8")
  return home
}

beforeEach(() => {
  resetImprovedHarnessCacheForTests()
})

describe("adopted harness read-back", () => {
  it("returns nothing when nothing was adopted", () => {
    expect(loadImprovedHarnessBlock(emptyHome())).toBe("")
  })

  it("renders the active harness into a prompt block", () => {
    const block = loadImprovedHarnessBlock(homeWithHarness())
    expect(block).toContain("# ADOPTED HARNESS")
    expect(block).toContain("Search before writing")
    expect(block).toContain("Never delete a branch")
  })

  it("folds in the newest lesson index", () => {
    const home = homeWithHarness()
    const area = join(home, ".nemo", "harness", "library", "agg", "acme")
    mkdirSync(area, { recursive: true })
    writeFileSync(join(area, "INDEX.md"), "- cue: flaky test\n  lesson: rerun once before blaming the code\n", "utf8")
    const block = loadImprovedHarnessBlock(home)
    expect(block).toContain("# LESSONS FROM PRIOR RUNS")
    expect(block).toContain("rerun once before blaming the code")
  })

  it("composes the session context with what was learned", () => {
    const home = homeWithHarness()
    const composed = composeHarnessBlock("session rules", home)
    expect(composed).toContain("session rules")
    expect(composed).toContain("# ADOPTED HARNESS")
    expect(composeHarnessBlock(undefined, emptyHome())).toBeUndefined()
  })

  it("survives an unreadable harness directory", () => {
    const home = homeWithHarness()
    const file = join(home, ".nemo", "harness", "systemprompt.md")
    chmodSync(file, 0o000)
    expect(() => loadImprovedHarnessBlock(home)).not.toThrow()
  })
})
