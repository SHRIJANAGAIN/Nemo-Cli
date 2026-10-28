/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

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
    // Landlock is NOT os-capable here. It is a `SandboxBackend` member and it used
    // to be admitted, which made `enforcementFor("landlock")` answer
    // `os-sandbox` for an enforcement path no code implements. `landlock.ts`
    // plans rulesets; the syscall that installs one does not exist.
    expect(osCapableBackend("landlock")).toBe(false)
    expect(osCapableBackend("bwrap")).toBe(true)
    expect(osCapableBackend("windows-restricted")).toBe(true)
    expect(osCapableBackend("fallback")).toBe(false)
    expect(osCapableBackend("")).toBe(false)
  })
})

describe("shouldUseOsSandbox", () => {
  it("engages seatbelt/bwrap/windows-restricted out of the box now that the flag is stable-on", () => {
    delete process.env[FLAG]

    expect(shouldUseOsSandbox(SandboxType.MacosSeatbelt)).toBe(true)
    expect(shouldUseOsSandbox(SandboxType.LinuxSeccomp)).toBe(true)
    expect(shouldUseOsSandbox(SandboxType.WindowsRestrictedToken)).toBe(true)
  })

  it("never engages for platforms with no OS isolator", () => {
    delete process.env[FLAG]

    expect(shouldUseOsSandbox(SandboxType.None)).toBe(false)
  })

  it("still honours an explicit opt-out", () => {
    process.env[FLAG] = "0"

    expect(shouldUseOsSandbox(SandboxType.MacosSeatbelt)).toBe(false)
    expect(shouldUseOsSandbox(SandboxType.LinuxSeccomp)).toBe(false)
    expect(shouldUseOsSandbox(SandboxType.WindowsRestrictedToken)).toBe(false)
  })

  it("still honours an explicit opt-in on any host", () => {
    process.env[FLAG] = "1"

    expect(shouldUseOsSandbox(SandboxType.MacosSeatbelt)).toBe(true)
    expect(shouldUseOsSandbox(SandboxType.LinuxSeccomp)).toBe(true)
    expect(shouldUseOsSandbox(SandboxType.WindowsRestrictedToken)).toBe(true)
  })
})

describe("describeEnforcement", () => {
  it("reports os-sandbox by default for a capable backend", () => {
    delete process.env[FLAG]

    expect(describeEnforcement("seatbelt")).toBe("os-sandbox")
    expect(describeEnforcement("bwrap")).toBe("os-sandbox")
    expect(describeEnforcement("windows-restricted")).toBe("os-sandbox")
  })

  it("never claims os-sandbox where no isolator exists", () => {
    delete process.env[FLAG]

    expect(describeEnforcement("fallback")).toBe("policy-only")
  })

  it("drops back to policy-only when the flag is explicitly disabled", () => {
    process.env[FLAG] = "false"

    expect(describeEnforcement("seatbelt")).toBe("policy-only")
    expect(describeEnforcement("bwrap")).toBe("policy-only")
    expect(describeEnforcement("windows-restricted")).toBe("policy-only")
  })
})
