/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { bugFixTaskLabel, shouldAutoSpawnBugFix } from "./bug-fix-auto.js"

describe("shouldAutoSpawnBugFix", () => {
  it("fires for tool_error only at two or more consecutive errors", () => {
    expect(shouldAutoSpawnBugFix("tool_error", 0)).toBe(false)
    expect(shouldAutoSpawnBugFix("tool_error", 1)).toBe(false)
    expect(shouldAutoSpawnBugFix("tool_error", 2)).toBe(true)
    expect(shouldAutoSpawnBugFix("tool_error", 100)).toBe(true)
  })

  it("fires immediately for permission_denied and tui_error", () => {
    expect(shouldAutoSpawnBugFix("permission_denied", 0)).toBe(true)
    expect(shouldAutoSpawnBugFix("permission_denied", 5)).toBe(true)
    expect(shouldAutoSpawnBugFix("tui_error", 0)).toBe(true)
    expect(shouldAutoSpawnBugFix("tui_error", 5)).toBe(true)
  })

  it("stays silent for unrelated event types", () => {
    expect(shouldAutoSpawnBugFix("info", 9)).toBe(false)
    expect(shouldAutoSpawnBugFix("", 9)).toBe(false)
    expect(shouldAutoSpawnBugFix("tool_errored", 9)).toBe(false)
  })
})

describe("bugFixTaskLabel", () => {
  it("formats the tool name and error", () => {
    expect(bugFixTaskLabel("bash", "command failed")).toBe("[bug-fix] bash: command failed")
  })

  it("truncates the error to 200 characters", () => {
    const label = bugFixTaskLabel("bash", "e".repeat(250))
    expect(label).toBe("[bug-fix] bash: " + "e".repeat(200))
    expect(label).toHaveLength("[bug-fix] bash: ".length + 200)
  })

  it("keeps short errors intact", () => {
    expect(bugFixTaskLabel("edit", "boom")).toBe("[bug-fix] edit: boom")
  })
})
