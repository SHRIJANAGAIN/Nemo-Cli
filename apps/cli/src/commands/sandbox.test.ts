/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, describe, expect, it } from "vitest"
import { execpolicyCommand, sandboxCommand } from "./sandbox.js"

const FLAG = "FEATURE_SANDBOXSPAWN"
const saved = process.env[FLAG]

afterEach(() => {
  if (saved === undefined) delete process.env[FLAG]
  else process.env[FLAG] = saved
})

describe("sandboxCommand", () => {
  it("reports the backend and honest policy-only enforcement by default", () => {
    delete process.env[FLAG]

    const out = sandboxCommand([])

    expect(out).toContain("backend:")
    expect(out).toContain("enforcement: policy-only")
    expect(out).toContain("Usage: trayambak sandbox check <file>")
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
})
