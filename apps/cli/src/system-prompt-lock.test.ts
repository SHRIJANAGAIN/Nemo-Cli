/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * System-prompt leak lock: `--dump-system-prompt` must die loudly at the
 * gate (exit 2, refusal on stderr, nothing on stdout) no matter where the
 * flag appears — and the refusal itself must never echo prompt content.
 * The registry-side half (no such flag registered) is pinned in
 * command-registry.test.ts; this pins the runtime refusal in index.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { knownFlagNames, refuseSystemPromptDump } from "./command-registry.js"

describe("system-prompt dump lock", () => {
  let stderr = ""
  // Loose spy type: only the call assertions below are used, and pinning the
  // full overloaded `process.stderr.write` generic breaks across vitest minor
  // versions (unrelated churn must not fail the shared build).
  let writeSpy: { mock: { calls: unknown[][] } }
  const realExitCode = process.exitCode
  // The refusal also appends to the security trail — point it at tmp so the
  // suite never mines false hits into the real ~/.trayambak/security.log.
  const trailFile = path.join(os.tmpdir(), `trayambak-lock-test-${process.pid}.log`)

  beforeEach(() => {
    stderr = ""
    process.exitCode = undefined
    try {
      fs.rmSync(trailFile, { force: true })
    } catch {
      /* best effort */
    }
    vi.stubEnv("TRAYAMBAK_SECURITY_LOG", trailFile)
    writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr += String(chunk)
      return true
    }) as typeof process.stderr.write)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    process.exitCode = realExitCode
    try {
      fs.rmSync(trailFile, { force: true })
    } catch {
      /* best effort */
    }
  })

  it("refuses --dump-system-prompt in any argv position", () => {
    for (const argv of [
      ["trayambak", "--dump-system-prompt"],
      ["trayambak", "chat", "--dump-system-prompt", "hi"],
      ["trayambak", "--dump-system-prompt", "--ink"],
    ]) {
      expect(refuseSystemPromptDump(argv, "trayambak")).toBe(true)
    }
    expect(process.exitCode).toBe(2)
    // Loud, not silent — and the message names the removal, never content.
    expect(stderr).toContain("--dump-system-prompt was removed")
    expect(stderr).toContain("never printed, logged or persisted")
    expect(writeSpy.mock.calls.length).toBeGreaterThan(0)
  })

  it("lets ordinary argv through untouched (no writes, no exit code)", () => {
    for (const argv of [
      ["trayambak", "chat", "hi"],
      ["trayambak", "--help"],
      ["trayambak", "--version"],
    ]) {
      expect(refuseSystemPromptDump(argv, "trayambak")).toBe(false)
    }
    expect(stderr).toBe("")
    expect(process.exitCode).toBeUndefined()
    expect(writeSpy.mock.calls).toHaveLength(0)
  })

  it("uses the invoking shim name so the skt binary refuses identically", () => {
    expect(refuseSystemPromptDump(["skt", "--dump-system-prompt"], "skt")).toBe(true)
    expect(stderr.startsWith("skt:")).toBe(true)
  })

  it("no dump-flavoured flag exists under any name", () => {
    for (const name of knownFlagNames()) {
      expect(name).not.toMatch(/dump|system.?prompt/i)
    }
  })
})
