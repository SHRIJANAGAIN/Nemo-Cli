/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { join, resolve } from "node:path"
import { scopedApproval } from "./harness-ports.js"

const workspace = resolve("/tmp/nemo-harness/context")

describe("scoped harness approval", () => {
  it("allows a file tool that stays inside the workspace", async () => {
    const approve = scopedApproval(workspace)
    await expect(approve("write_file", { path: "harness/systemprompt.md", content: "x" })).resolves.toBe(true)
    await expect(approve("read_file", { path: join(workspace, "context/systemprompt.md") })).resolves.toBe(true)
  })

  it("refuses an absolute path outside the workspace", async () => {
    const approve = scopedApproval(workspace)
    await expect(approve("write_file", { path: resolve("/etc/passwd") })).resolves.toBe(false)
  })

  it("refuses traversal and escaping globs", async () => {
    const approve = scopedApproval(workspace)
    await expect(approve("edit_file", { path: "../../secrets.txt" })).resolves.toBe(false)
    await expect(approve("glob", { pattern: "../**/*.ts" })).resolves.toBe(false)
  })

  it("never approves a shell or a network tool", async () => {
    const approve = scopedApproval(workspace)
    await expect(approve("bash", { command: "npm test" })).resolves.toBe(false)
    await expect(approve("web_fetch", { url: "https://example.com" })).resolves.toBe(false)
  })
})
