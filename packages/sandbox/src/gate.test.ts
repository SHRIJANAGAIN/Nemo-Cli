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
  it("engages seatbelt/landlock out of the box now that the flag is stable-on", () => {
    delete process.env[FLAG]

    expect(shouldUseOsSandbox(SandboxType.MacosSeatbelt)).toBe(true)
    expect(shouldUseOsSandbox(SandboxType.LinuxSeccomp)).toBe(true)
  })

  it("never engages for backends with no OS isolator", () => {
    delete process.env[FLAG]

    expect(shouldUseOsSandbox(SandboxType.WindowsRestrictedToken)).toBe(false)
    expect(shouldUseOsSandbox(SandboxType.None)).toBe(false)
  })

  it("still honours an explicit opt-out", () => {
    process.env[FLAG] = "0"

    expect(shouldUseOsSandbox(SandboxType.MacosSeatbelt)).toBe(false)
    expect(shouldUseOsSandbox(SandboxType.LinuxSeccomp)).toBe(false)
  })

  it("still honours an explicit opt-in on any host", () => {
    process.env[FLAG] = "1"

    expect(shouldUseOsSandbox(SandboxType.MacosSeatbelt)).toBe(true)
    expect(shouldUseOsSandbox(SandboxType.LinuxSeccomp)).toBe(true)
  })
})

describe("describeEnforcement", () => {
  it("reports os-sandbox by default for a capable backend", () => {
    delete process.env[FLAG]

    expect(describeEnforcement("seatbelt")).toBe("os-sandbox")
    expect(describeEnforcement("bwrap")).toBe("os-sandbox")
  })

  it("never claims os-sandbox where no isolator exists", () => {
    delete process.env[FLAG]

    expect(describeEnforcement("windows-restricted")).toBe("policy-only")
    expect(describeEnforcement("fallback")).toBe("policy-only")
  })

  it("drops back to policy-only when the flag is explicitly disabled", () => {
    process.env[FLAG] = "false"

    expect(describeEnforcement("seatbelt")).toBe("policy-only")
    expect(describeEnforcement("bwrap")).toBe("policy-only")
  })
})
