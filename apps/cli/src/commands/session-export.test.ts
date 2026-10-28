/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { sessionExportCommand } from "./session-export.js"
// Persisted conversation store — the same one resume/restore reads.
import { appendConversation, createSession } from "../../../../nemo/9-session/session.js"

let savedExitCode: number | undefined
let savedHome: string | undefined
let tempHome: string | undefined

function readExitCode(): number | undefined {
  return (process as { exitCode?: number }).exitCode
}

afterEach(() => {
  process.exitCode = savedExitCode
  if (tempHome) {
    if (savedHome !== undefined) process.env.NEMO_HOME = savedHome
    else delete process.env.NEMO_HOME
    savedHome = undefined
    try {
      fs.rmSync(tempHome, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    tempHome = undefined
  }
})

/** Isolate the nemo conversation store (session.test.ts pattern): NEMO_HOME
 *  must contain BOTH package.json and nemo/8-conversations, or sessions would
 *  land in the repo. */
function isolateSessionStore(): void {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-export-home-"))
  fs.writeFileSync(path.join(tempHome, "package.json"), '{"name":"tmp"}', "utf8")
  fs.mkdirSync(path.join(tempHome, "nemo", "8-conversations"), { recursive: true })
  savedHome = process.env.NEMO_HOME
  process.env.NEMO_HOME = tempHome
}

describe("sessionExportCommand", () => {
  it("exits 1 on an empty transcript", () => {
    savedExitCode = readExitCode()
    process.exitCode = undefined

    expect(sessionExportCommand({ sessionId: "", format: "markdown" })).toBe("No messages to export")
    expect(readExitCode()).toBe(1)
  })

  it("exits 1 when the session filter matches nothing", () => {
    savedExitCode = readExitCode()
    process.exitCode = undefined

    // NOTE: the deleted in-memory sessionTranscript's .add() used to sit
    // here, but it wrote to a different store than the persisted "ghost"
    // lookup below asserts on — dropping it changes nothing asserted.
    expect(sessionExportCommand({ sessionId: "ghost", format: "text" })).toBe(
      "No messages found for session ghost",
    )
    expect(readExitCode()).toBe(1)
  })

  it("exits 2 on a session id that is not a single path segment", () => {
    savedExitCode = readExitCode()
    process.exitCode = undefined

    expect(sessionExportCommand({ sessionId: "../evil", format: "json" })).toBe("invalid session id: ../evil")
    expect(readExitCode()).toBe(2)

    process.exitCode = undefined
    expect(sessionExportCommand({ sessionId: "..\\evil", format: "markdown" })).toBe("invalid session id: ..\\evil")
    expect(readExitCode()).toBe(2)
  })

  it("exports a persisted session's conversation by session id (markdown)", () => {
    savedExitCode = readExitCode()
    process.exitCode = undefined
    isolateSessionStore()

    const s = createSession("demo", "export target")
    appendConversation(s.sessionId, "user", "hello world")
    appendConversation(s.sessionId, "assistant", "hi back")
    appendConversation(s.sessionId, "system", "SECRET SYSTEM NOTE")
    appendConversation(s.sessionId, "tool", '{"command":"ls"}', { toolName: "bash" })

    const md = sessionExportCommand({ sessionId: s.sessionId, format: "markdown" })
    expect(md).toContain("# Session Export")
    expect(md).toContain("### user\nhello world")
    expect(md).toContain("### assistant\nhi back")
    // System rows only on request; tool rows (raw args JSON) never.
    expect(md).not.toContain("SECRET SYSTEM NOTE")
    expect(md).not.toContain("### tool")

    const withSystem = sessionExportCommand({ sessionId: s.sessionId, format: "markdown", includeSystem: true })
    expect(withSystem).toContain("SECRET SYSTEM NOTE")
    expect(withSystem).not.toContain("### tool")
    expect(readExitCode()).toBeUndefined()
  })

  it("exports json as role/content rows", () => {
    savedExitCode = readExitCode()
    process.exitCode = undefined
    isolateSessionStore()

    const s = createSession("json", "")
    appendConversation(s.sessionId, "user", "ping")
    appendConversation(s.sessionId, "assistant", "pong")

    const parsed = JSON.parse(sessionExportCommand({ sessionId: s.sessionId, format: "json" })) as Array<{
      role: string
      content: string
    }>
    expect(parsed).toEqual([
      { role: "user", content: "ping" },
      { role: "assistant", content: "pong" },
    ])
  })
})
