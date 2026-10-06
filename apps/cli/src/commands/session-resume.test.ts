/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * resume against an empty store: misses are operational failures (exit 1),
 * never silent success. The sessionManager singleton reads
 * TRAYAMBAK_SESSIONS_FILE at module load, so the env is pinned before the
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-resume-"))
  savedFile = process.env.TRAYAMBAK_SESSIONS_FILE
  process.env.TRAYAMBAK_SESSIONS_FILE = path.join(tmp, "sessions.json")
  savedExitCode = readExitCode()
  process.exitCode = undefined
  const mod = await import("./session-resume.js")
  resumeCommand = mod.sessionResumeCommand
})

afterEach(() => {
  if (savedFile === undefined) delete process.env.TRAYAMBAK_SESSIONS_FILE
  else process.env.TRAYAMBAK_SESSIONS_FILE = savedFile
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
