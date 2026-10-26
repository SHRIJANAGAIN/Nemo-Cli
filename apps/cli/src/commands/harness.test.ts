/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formatHarness, harnessPaths, loadActiveHarness, saveActiveHarness } from "./harness.js"
import { baseHarness, CODING_AGENT_PROFILE } from "../../../../packages/core/src/harness/index.js"

let home = ""

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "harness-cli-"))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe("harness command helpers", () => {
  it("puts the active harness and the library under the home directory", () => {
    const paths = harnessPaths("docs", home)
    expect(paths.active).toContain(join(".nemo", "harness"))
    expect(paths.libraryRoot).toContain("library")
    expect(paths.runsRoot).toContain("runs")
  })

  it("falls back to the base harness when nothing is saved", () => {
    const tree = loadActiveHarness(home)
    expect(tree["systemprompt.md"]).toBe(baseHarness(CODING_AGENT_PROFILE)["systemprompt.md"])
  })

  it("round-trips a saved harness", () => {
    const tree = { ...baseHarness(), "guardrails.md": "- Ask first." }
    saveActiveHarness(tree, home)
    const loaded = loadActiveHarness(home)
    expect(loaded["guardrails.md"]).toBe("- Ask first.")
  })

  it("describes the components for the terminal", () => {
    const text = formatHarness({
      ...baseHarness(),
      "skills/pdf/SKILL.md": "---\nname: pdf\ndescription: Read PDFs\n---\nbody",
    })
    expect(text).toContain("systemPrompt")
    expect(text).toContain("skills/pdf/SKILL.md")
    expect(text).toContain("pdf")
  })
})
