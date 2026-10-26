/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  lessonCue,
  readHarnessStatus,
  resetHarnessStatusCacheForTests,
} from "./harness-status.js"

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nemo-harness-status-"))
  resetHarnessStatusCacheForTests()
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  resetHarnessStatusCacheForTests()
})

const experience = (cue: string): string =>
  `${JSON.stringify({ cue, lesson: `do ${cue}`, evidence: "run-1" })}\n\npicked because it was simpler.\n`

describe("readHarnessStatus", () => {
  it("reports nothing on a home that has never improved", () => {
    expect(readHarnessStatus(home)).toEqual({ lessons: 0, pending: 0 })
  })

  it("counts stored lessons, queued jobs and the newest cue", () => {
    const root = join(home, ".nemo", "harness")
    const first = join(root, "library", "parallel", "coding", "harnesses", "t1")
    const second = join(root, "library", "sequential", "review", "harnesses", "t2")
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })
    writeFileSync(join(first, "EXPERIENCE.md"), experience("prefer rg over grep"), "utf8")
    writeFileSync(join(second, "EXPERIENCE.md"), experience("run the narrow test first"), "utf8")
    mkdirSync(join(root, "pending"), { recursive: true })
    writeFileSync(join(root, "pending", "job.json"), "{}", "utf8")
    writeFileSync(join(root, "auto.log"), "ok\n", "utf8")

    const status = readHarnessStatus(home)
    expect(status.lessons).toBe(2)
    expect(status.pending).toBe(1)
    expect(status.adoptedAt).toBeTypeOf("number")
    expect(status.lastAutoAt).toBeTypeOf("number")
    expect(status.lastLesson).toBeTypeOf("string")
  })

  it("survives a half-written EXPERIENCE.md", () => {
    const dir = join(home, ".nemo", "harness", "library", "parallel", "coding", "harnesses", "t1")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "EXPERIENCE.md"), '{"cue": "unterminated', "utf8")
    const status = readHarnessStatus(home)
    expect(status.lessons).toBe(1)
    expect(status.lastLesson).toBeUndefined()
  })
})

describe("lessonCue", () => {
  it("reads the cue and tolerates the prose suffix the library appends", () => {
    expect(lessonCue(experience("batch the edits"))).toBe("batch the edits")
  })

  it("returns undefined when there is no cue", () => {
    expect(lessonCue("plain prose only")).toBeUndefined()
    expect(lessonCue('"cue": ""')).toBeUndefined()
  })
})
