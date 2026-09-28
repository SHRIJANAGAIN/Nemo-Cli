/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
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
