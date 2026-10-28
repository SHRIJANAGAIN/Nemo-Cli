/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/** `.agentignore` parsing, rule mapping, and ladder end-to-end denial. */

import { describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { evaluatePermission } from "../../../packages/protocol/src/permission-rules.js"
import {
  AGENTIGNORE_FILE,
  AGENTIGNORE_MAX_LINES,
  agentignoreDenyRules,
  loadAgentignorePatterns,
  parseAgentignore,
} from "./agentignore.js"

function projectWithIgnore(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-ignore-"))
  fs.writeFileSync(path.join(dir, AGENTIGNORE_FILE), body)
  return dir
}

describe("parseAgentignore", () => {
  it("keeps globs, drops comments/blanks/negations", () => {
    expect(parseAgentignore("# creds\n\n*.pem\n.env\n!public.pem\n  secrets/  \n")).toEqual([
      "*.pem",
      ".env",
      "secrets/",
    ])
  })

  it("caps runaway files", () => {
    const many = Array.from({ length: AGENTIGNORE_MAX_LINES + 50 }, (_, i) => `f${i}.key`).join("\n")
    expect(parseAgentignore(many)).toHaveLength(AGENTIGNORE_MAX_LINES)
  })
})

describe("loadAgentignorePatterns", () => {
  it("reads the cwd file and returns [] when absent", () => {
    expect(loadAgentignorePatterns(projectWithIgnore("*.pem\n"))).toEqual(["*.pem"])
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-ignore-empty-"))
    expect(loadAgentignorePatterns(empty)).toEqual([])
    expect(loadAgentignorePatterns(path.join(empty, "no-such-dir"))).toEqual([])
  })
})

describe("agentignoreDenyRules", () => {
  it("maps to deny-all-tools rules with backslash variants for slashed patterns", () => {
    const dir = projectWithIgnore("*.pem\nsecrets/*.key\n")
    const rules = agentignoreDenyRules(dir)
    expect(rules).toEqual([
      { tool: "*", pattern: "*.pem", action: "deny", reason: ".agentignore: *.pem" },
      { tool: "*", pattern: "secrets/*.key", action: "deny", reason: ".agentignore: secrets/*.key" },
      { tool: "*", pattern: "secrets\\*.key", action: "deny", reason: ".agentignore: secrets/*.key" },
    ])
  })

  it("denies through the real ladder for absolute and relative subjects", () => {
    const dir = projectWithIgnore("*.pem\n.env\n")
    const rules = agentignoreDenyRules(dir)
    const config = { mode: "default", rules: [], askByDefault: true, rulesV2: rules } as never
    expect(evaluatePermission("read_file", { path: `${dir}/cert.pem` }, config).action).toBe("deny")
    expect(evaluatePermission("read_file", { path: "sub/dir/.env" }, config).action).toBe("deny")
    expect(evaluatePermission("read_file", { path: `${dir}/main.ts` }, config).action).not.toBe("deny")
  })
})
