/* Copyright 2026 SKT AI LABS PRIVATE LIMITED.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { decidePermission, DenialTracker, parseRule, parseRules } from "./permissions.js"

describe("permissions", () => {
  it("parses Tool(glob) and bare names", () => {
    expect(parseRule("Bash(npm *)")).toMatchObject({ tool: "Bash", pattern: "npm *", allow: true })
    expect(parseRule("!Bash(rm -rf *)")).toMatchObject({ tool: "Bash", allow: false })
    expect(parseRule("Write")).toMatchObject({ tool: "Write", pattern: "*" })
    expect(parseRule("")).toBeNull()
    expect(parseRule("# comment")).toBeNull()
    expect(parseRule("Bash(unclosed")).toBeNull()
  })

  it("deny wins over allow", () => {
    const rules = parseRules(["Bash(*)", "!Bash(rm -rf *)"])
    expect(decidePermission(rules, "Bash", "npm test")).toBe("allow")
    expect(decidePermission(rules, "Bash", "rm -rf /")).toBe("deny")
    expect(decidePermission(rules, "Write", "a.ts")).toBe("ask")
  })

  it("tool globs and substring subjects", () => {
    const rules = parseRules(["write_*(*.ts)"])
    expect(decidePermission(rules, "write_file", "src/a.ts")).toBe("allow")
    expect(decidePermission(rules, "read_file", "src/a.ts")).toBe("ask")
  })

  it("tracks denials per tool", () => {
    const tracker = new DenialTracker()
    expect(tracker.record("Bash")).toBe(1)
    expect(tracker.record("Bash")).toBe(2)
    expect(tracker.count("Bash")).toBe(2)
    expect(tracker.total()).toBe(2)
    expect(tracker.getLastDeniedAt()).toBeGreaterThan(0)
    tracker.reset("Bash")
    expect(tracker.count("Bash")).toBe(0)
    tracker.record("Write")
    tracker.reset()
    expect(tracker.total()).toBe(0)
  })
})
