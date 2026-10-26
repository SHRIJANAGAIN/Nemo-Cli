/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * resume against an empty store: misses are operational failures (exit 1),
 * never silent success. The sessionManager singleton reads
 * NEMO_SESSIONS_FILE at module load, so the env is pinned before the
 * dynamic import — mirroring doctor.test.ts.
 */

let tmp = ""
let savedFile: string | undefined
let savedExitCode: number | undefined
let resumeCommand: (options: { sessionId: string }) => string

function readExitCode(): number | undefined {
  return (process as { exitCode?: number }).exitCode
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-resume-"))
  savedFile = process.env.NEMO_SESSIONS_FILE
  process.env.NEMO_SESSIONS_FILE = path.join(tmp, "sessions.json")
  savedExitCode = readExitCode()
  process.exitCode = undefined
  const mod = await import("./session-resume.js")
  resumeCommand = mod.sessionResumeCommand
})

afterEach(() => {
  if (savedFile === undefined) delete process.env.NEMO_SESSIONS_FILE
  else process.env.NEMO_SESSIONS_FILE = savedFile
  process.exitCode = savedExitCode
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe("sessionResumeCommand", () => {
  it("exits 1 on a missing session", () => {
    expect(resumeCommand({ sessionId: "ghost" })).toBe("Session ghost not found")
    expect(readExitCode()).toBe(1)
  })
})
