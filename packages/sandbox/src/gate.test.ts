/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

import { afterEach, describe, expect, it } from "vitest"
import { SandboxType } from "./types.js"
import { describeEnforcement, osCapableBackend, shouldUseOsSandbox } from "./gate.js"

const FLAG = "FEATURE_SANDBOXSPAWN"
const saved = process.env[FLAG]

afterEach(() => {
  if (saved === undefined) delete process.env[FLAG]
  else process.env[FLAG] = saved
})

describe("osCapableBackend", () => {
  it("admits only backends with a real isolator", () => {
    expect(osCapableBackend("seatbelt")).toBe(true)
    expect(osCapableBackend("landlock")).toBe(true)
    expect(osCapableBackend("bwrap")).toBe(true)
    expect(osCapableBackend("windows-restricted")).toBe(false)
    expect(osCapableBackend("fallback")).toBe(false)
    expect(osCapableBackend("")).toBe(false)
  })
})

describe("shouldUseOsSandbox", () => {
  it("stays policy-only while the flag is off, whatever the backend", () => {
    delete process.env[FLAG]

    expect(shouldUseOsSandbox(SandboxType.MacosSeatbelt)).toBe(false)
    expect(shouldUseOsSandbox(SandboxType.LinuxSeccomp)).toBe(false)
    expect(shouldUseOsSandbox(SandboxType.None)).toBe(false)
  })

  it("engages only seatbelt/landlock when the flag is on", () => {
    process.env[FLAG] = "1"

    expect(shouldUseOsSandbox(SandboxType.MacosSeatbelt)).toBe(true)
    expect(shouldUseOsSandbox(SandboxType.LinuxSeccomp)).toBe(true)
    expect(shouldUseOsSandbox(SandboxType.WindowsRestrictedToken)).toBe(false)
    expect(shouldUseOsSandbox(SandboxType.None)).toBe(false)
  })
})

describe("describeEnforcement", () => {
  it("reports policy-only by default", () => {
    delete process.env[FLAG]

    expect(describeEnforcement("seatbelt")).toBe("policy-only")
  })

  it("reports os-sandbox only for capable backends under the flag", () => {
    process.env[FLAG] = "true"

    expect(describeEnforcement("seatbelt")).toBe("os-sandbox")
    expect(describeEnforcement("bwrap")).toBe("os-sandbox")
    expect(describeEnforcement("windows-restricted")).toBe("policy-only")
    expect(describeEnforcement("fallback")).toBe("policy-only")
  })
})
