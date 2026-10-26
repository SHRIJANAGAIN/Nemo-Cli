/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import { describe, expect, it } from "vitest"
import { isRemoteUncPath, validateToolUse } from "./validate.js"

describe("validateToolUse", () => {
  it("rejects missing path", () => {
    expect(validateToolUse("read_file", {}, ["path"])).toContain("path")
  })
  it("accepts present args", () => {
    expect(validateToolUse("read_file", { path: "a.txt" }, ["path"])).toBeNull()
  })
})

describe("isRemoteUncPath (shared UNC choke point)", () => {
  it("flags remote shares and lets local paths through", () => {
    expect(isRemoteUncPath("\\\\host\\share\\x.json")).toBe(true)
    expect(isRemoteUncPath("//host/share/x.json")).toBe(true)
    expect(isRemoteUncPath("\\\\?\\UNC\\host\\share")).toBe(true)
    expect(isRemoteUncPath("C:\\local\\x.json")).toBe(false)
    expect(isRemoteUncPath("./relative/x.json")).toBe(false)
    expect(isRemoteUncPath("\\\\?\\C:\\local")).toBe(false)
    expect(isRemoteUncPath("\\\\.\\PhysicalDrive0")).toBe(false)
    expect(isRemoteUncPath("")).toBe(false)
  })
})
