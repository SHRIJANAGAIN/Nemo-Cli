/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, describe, expect, it } from "vitest"
import { execpolicyCommand, sandboxCommand } from "./sandbox.js"

const FLAG = "FEATURE_SANDBOXSPAWN"
const saved = process.env[FLAG]
const savedExitCode = process.exitCode

afterEach(() => {
  if (saved === undefined) delete process.env[FLAG]
  else process.env[FLAG] = saved
  process.exitCode = savedExitCode
})

describe("sandboxCommand", () => {
  it("reports the backend and honest policy-only enforcement by default", () => {
    delete process.env[FLAG]

    const out = sandboxCommand([])

    expect(out).toContain("backend:")
    expect(out).toContain("enforcement: policy-only")
    expect(out).toContain("Usage: nemo sandbox check <file>")
  })

  it("stays policy-only on backends without an isolator even with the flag on", () => {
    process.env[FLAG] = "1"

    const out = sandboxCommand([])
    // This box has no seatbelt/bwrap, so honesty means policy-only here;
    // capable hosts flip to the os-sandbox line (see gate tests).
    if (out.includes("backend: fallback") || out.includes("backend: windows-restricted")) {
      expect(out).toContain("enforcement: policy-only")
    } else {
      expect(out).toContain("enforcement: os-sandbox")
    }
  })

  it("checks file writes against the workspace policy", () => {
    expect(sandboxCommand(["check", "src/index.ts"])).toContain("allow")
  })
})

describe("execpolicyCommand", () => {
  it("denies destructive commands and allows the rest", () => {
    expect(execpolicyCommand(["check", "rm -rf /*"])).toContain("deny")
    expect(execpolicyCommand(["check", "echo hi"])).toBe("allow")
  })

  it("prints usage without a command", () => {
    expect(execpolicyCommand([])).toContain("Usage:")
  })

  it("denies chained destructive payloads through the CLI surface", () => {
    expect(execpolicyCommand(["check", "echo ok; mkfs.ext4 /dev/sda"])).toContain("deny")
    expect(execpolicyCommand(["check", "true && shutdown -h now"])).toContain("deny")
    expect(execpolicyCommand(["check", "git push --force"])).toContain("deny")
    expect(execpolicyCommand(["check", "echo hi"])).toBe("allow")
  })

  it("exits 3 on deny, 2 on usage, leaves 0 on allow (CI-gatable)", () => {
    process.exitCode = undefined
    expect(execpolicyCommand(["check", "rm -rf /"])).toContain("deny")
    expect(process.exitCode).toBe(3)
    process.exitCode = undefined
    expect(execpolicyCommand(["check", "echo hi"])).toBe("allow")
    expect(process.exitCode).toBeUndefined()
    process.exitCode = undefined
    expect(execpolicyCommand([])).toContain("Usage:")
    expect(process.exitCode).toBe(2)
  })
})
