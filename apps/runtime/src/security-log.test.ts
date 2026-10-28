/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { logSecurityEvent, securityLogPath } from "./security-log.js"

function tmpLog(): string {
  const file = join(mkdtempSync(join(tmpdir(), "sec-log-")), "security.log")
  vi.stubEnv("NEMO_SECURITY_LOG", file)
  return file
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("security-log trail", () => {
  it("appends one JSON line per event with a timestamp", () => {
    const file = tmpLog()
    logSecurityEvent({ type: "prompt_exfil_attempt", flag: "--dump-system-prompt" })
    logSecurityEvent({ type: "prompt_exfil_attempt", flag: "--dump-system-prompt-2" })
    const lines = readFileSync(file, "utf8").trim().split("\n")
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0]) as { type: string; at: string; flag: string }
    expect(first.type).toBe("prompt_exfil_attempt")
    expect(first.flag).toBe("--dump-system-prompt")
    expect(typeof first.at).toBe("string")
  })

  it("never lets key material land raw — values and embedded tokens alike", () => {
    const file = tmpLog()
    logSecurityEvent({
      type: "prompt_exfil_attempt",
      flag: "--dump-system-prompt",
      // Credential-shaped value + token embedded in prose: both must die.
      args: { apiKey: "sk-live-0123456789abcdef", note: "pasted ghp_0123456789abcdefghij for later" },
    })
    const line = readFileSync(file, "utf8")
    expect(line).not.toContain("sk-live-0123456789abcdef")
    expect(line).not.toContain("ghp_0123456789abcdefghij")
    expect(line).toContain("prompt_exfil_attempt")
  })

  it("never throws — not even on an unwritable path", () => {
    // A directory is not appendable: must swallow, not crash the caller.
    vi.stubEnv("NEMO_SECURITY_LOG", tmpdir())
    expect(() => logSecurityEvent({ type: "prompt_exfil_attempt" })).not.toThrow()
    expect(securityLogPath()).toBe(tmpdir())
  })
})
