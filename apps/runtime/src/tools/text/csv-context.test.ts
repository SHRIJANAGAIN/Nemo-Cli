/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createCsvTool } from "./csv.js"
import type { ToolContext } from "../types.js"

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("csv tool cwd contract", () => {
  it("resolves relative files against the tool context cwd, not process.cwd()", async () => {
    // Same worktree/subdir session class that diff/yaml/summarize were fixed
    // for — csv executed with `process.cwd()` so a file that exists under
    // context.cwd resolved against the repo root and failed with ENOENT.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-csv-ctx-"))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, "t.csv"), "ab,cd\ne,f\n", "utf8")
    const ctx = { cwd: dir } as unknown as ToolContext
    const tool = createCsvTool()
    const res = await tool.execute("t1", { file: "t.csv" }, undefined, undefined, ctx)
    expect(res.isError).toBe(false) // RED: "csv failed: ENOENT" (resolved against process.cwd())
  })
})