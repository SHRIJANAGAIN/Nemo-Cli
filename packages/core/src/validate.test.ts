/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import { describe, expect, it } from "vitest"
import { validateToolUse } from "./validate.js"

describe("validateToolUse", () => {
  it("rejects missing path", () => {
    expect(validateToolUse("read_file", {}, ["path"])).toContain("path")
  })
  it("accepts present args", () => {
    expect(validateToolUse("read_file", { path: "a.txt" }, ["path"])).toBeNull()
  })
})
