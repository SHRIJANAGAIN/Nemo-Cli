/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
// Live runtime file (what App.tsx imports) — not session.ts.
import {
  appendConversation,
  createSession,
  isTransientNotice,
  loadConversation,
  updateConversationToolResult,
} from "./session.js"

/**
 * Tool-result persistence round-trip: tool rows used to be saved only at
 * START, so resumed sessions showed args with no result and no ✓/✗
 * fidelity. tool_execution_end now patches the START row in place via
 * updateConversationToolResult — restore sees exactly one row WITH the
 * outcome.
 *
 * Isolation: sessionsDir() prefers TRAYAMBAK_HOME (with a package.json)
 * and falls back to the REPO's skt/8-conversations when the candidate dir
 * is missing — so the temp home MUST contain both package.json AND
 * skt/8-conversations, or this suite would pollute real sessions.
 */
describe("session tool-result persistence", () => {
  let home = ""
  let oldHome: string | undefined

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-sess-"))
    fs.writeFileSync(path.join(home, "package.json"), '{"name":"tmp"}', "utf8")
    fs.mkdirSync(path.join(home, "skt", "8-conversations"), { recursive: true })
    oldHome = process.env.TRAYAMBAK_HOME
    process.env.TRAYAMBAK_HOME = home
  })

  afterEach(() => {
    if (oldHome === undefined) delete process.env.TRAYAMBAK_HOME
    else process.env.TRAYAMBAK_HOME = oldHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  it("patches the START row in place (no duplicate) and restores the outcome", () => {
    const s = createSession("persist-t", "")
    appendConversation(s.sessionId, "user", "list files")
    appendConversation(s.sessionId, "assistant", JSON.stringify({ path: "." }), {
      toolCallId: "c1",
      toolName: "list_dir",
      toolStatus: "running",
    })

    updateConversationToolResult(s.sessionId, "c1", {
      result: "a.ts\nb.ts",
      isError: false,
      toolStatus: "completed",
    })

    const loaded = loadConversation(s.sessionId)
    // Still 2 rows — patched in place, never appended.
    expect(loaded).toHaveLength(2)
    const toolRow = loaded.find((e) => e.toolCallId === "c1")
    expect(toolRow?.toolStatus).toBe("completed")
    expect(toolRow?.result).toBe("a.ts\nb.ts")
    expect(toolRow?.isError).toBe(false)
  })

  it("leaves non-matching rows and garbage lines untouched", () => {
    const s = createSession("persist-t2", "")
    appendConversation(s.sessionId, "assistant", "{}", {
      toolCallId: "c9",
      toolName: "bash",
      toolStatus: "running",
    })
    // Unknown id → no-op, must not throw or rewrite.
    updateConversationToolResult(s.sessionId, "nope", { result: "x" })
    const loaded = loadConversation(s.sessionId)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].result).toBeUndefined()
    expect(loaded[0].toolStatus).toBe("running")
  })

  it("filters stale lifecycle banners restored from polluted logs", () => {
    expect(isTransientNotice("Resumed session: foo")).toBe(true)
    const s = createSession("persist-t3", "")
    appendConversation(s.sessionId, "system", "Resumed session: foo")
    appendConversation(s.sessionId, "user", "hi")
    const loaded = loadConversation(s.sessionId)
    expect(loaded.map((e) => e.content)).toEqual(["hi"])
  })
})
