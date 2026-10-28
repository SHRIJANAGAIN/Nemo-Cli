/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readJobTail, recordJob } from "./github-jobs.js"

describe("github job ledger", () => {
  it("appends rows and tails them newest-first, never throwing", () => {
    const file = join(mkdtempSync(join(tmpdir(), "gh-jobs-")), "jobs.jsonl")
    expect(readJobTail(10, file)).toEqual([])
    recordJob({ repo: "o/a", issue: 1, task: "hello", messages: 3, replyHead: "hi there" }, file)
    recordJob({ repo: "o/a", issue: 2, task: "x".repeat(500), messages: 1, replyHead: "y", error: "boom" }, file)
    const tail = readJobTail(10, file)
    expect(tail).toHaveLength(2)
    expect(tail[0]?.issue).toBe(2)
    expect(tail[0]?.error).toBe("boom")
    // Heads are capped, not verbatim dumps.
    const raw = readFileSync(file, "utf8")
    expect(raw).not.toContain("x".repeat(500))
    expect(() =>
      recordJob({ repo: "o", issue: 0, task: "", messages: 0, replyHead: "" }, join(file, "\0bad")),
    ).not.toThrow()
  })
})
