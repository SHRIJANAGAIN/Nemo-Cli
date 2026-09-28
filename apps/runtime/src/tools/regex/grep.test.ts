/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createGrepTool } from "./grep.js"
import type { ToolContext } from "../types.js"

/**
 * ReDoS guard: a pathological pattern on a mega-line must return fast
 * (skipped + reported), never block the event loop for minutes.
 */
describe("grep ReDoS guard", () => {
  let dir = ""
  const ctx = (): ToolContext => ({ cwd: dir }) as ToolContext

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-grep-"))
    fs.writeFileSync(path.join(dir, "normal.ts"), "hello world\nfoo bar\n")
    // Minified-style single mega-line ending in a NEAR-MISS: catastrophic
    // input for (a+)+$ (all-"a" would match fast; the trailing "b" forces
    // exponential backtracking without the guard).
    fs.writeFileSync(path.join(dir, "bundle.js"), "a".repeat(100_000) + "b")
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("skips over-long lines instead of hanging (evil pattern)", async () => {
    const tool = createGrepTool()
    const start = Date.now()
    const res = await tool.execute("t1", { pattern: "(a+)+$" }, undefined, undefined, ctx())
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(10000)
    const text = JSON.stringify(res)
    expect(text).toContain("skipped")
  }, 15000)

  it("still finds normal matches", async () => {
    const tool = createGrepTool()
    const res = await tool.execute("t2", { pattern: "hello", glob: "*.ts" }, undefined, undefined, ctx())
    expect(JSON.stringify(res)).toContain("hello world")
  })
})
