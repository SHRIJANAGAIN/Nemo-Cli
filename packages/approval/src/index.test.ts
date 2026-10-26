/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import { describe, expect, it } from "vitest"
import { checkAutoApproval, isProtectedFile, DEFAULT_APPROVAL } from "./index.js"

describe("approval", () => {
  it("allows git log prefix", () => {
    expect(checkAutoApproval("git log --oneline", DEFAULT_APPROVAL)).toBe("allow")
  })
  it("deny wins over allow", () => {
    expect(
      checkAutoApproval("git log", {
        allowedCommands: ["git log"],
        deniedCommands: ["git log"],
        protectedPatterns: [],
      }),
    ).toBe("deny")
  })
  it("unknown asks", () => {
    expect(checkAutoApproval("rm -rf /", DEFAULT_APPROVAL)).toBe("ask")
  })
  it("protects .roomodes", () => {
    expect(isProtectedFile(".roomodes")).toBe(true)
    expect(isProtectedFile("src/a.ts")).toBe(false)
  })
})
