/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * `sessionId` names a directory under `skt/8-conversations/`, and four exported
 * functions do something destructive with it: a recursive `rmSync`, a
 * `mkdirSync` + append, a whole-file rewrite, and a read.
 *
 * `sessions.json` is a plain JSON file, so a poisoned entry
 * (`{"sessionId":"../../canary"}`) turned the TUI session picker's delete —
 * `session-picker-actions.ts` imports `deleteSession` straight from this module
 * — into an arbitrary directory delete, and the log helpers into arbitrary file
 * append, overwrite and read.
 *
 * The canary is a real directory the traversal genuinely resolves to (two levels
 * above the sessions root), so every case asserts both that the helper refused
 * AND that the canary is untouched — the test fails if the guard is removed
 * rather than passing because the traversal happened to miss.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { appendConversation, deleteSession, loadConversation, updateConversationToolResult } from "./session.js"

/** Resolves from the sessions root to the canary, two levels up. */
const ESCAPE = "../../canary"
const HOSTILE = [ESCAPE, "../canary", "..\\canary", "a/b", "/absolute", "C:\\Windows", ".", "", "  "]

let tmp: string
let root: string
let canary: string
let canaryFile: string
let priorHome: string | undefined

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skt9-"))
  // `projectRoot()` prefers TRAYAMBAK_HOME when it holds a package.json, and
  // otherwise walks up from this file's own directory — which would resolve to
  // the real repo. Pin it to tmp so every write lands in the sandbox.
  fs.writeFileSync(path.join(tmp, "package.json"), "{}", "utf8")
  priorHome = process.env.TRAYAMBAK_HOME
  process.env.TRAYAMBAK_HOME = tmp

  root = path.join(tmp, "skt", "8-conversations")
  fs.mkdirSync(root, { recursive: true })

  canary = path.join(tmp, "canary")
  fs.mkdirSync(canary, { recursive: true })
  canaryFile = path.join(canary, "keep.txt")
  fs.writeFileSync(canaryFile, "must survive", "utf8")
})

afterEach(() => {
  if (priorHome === undefined) delete process.env.TRAYAMBAK_HOME
  else process.env.TRAYAMBAK_HOME = priorHome
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* best-effort cleanup */
  }
})

function canaryIntact(): boolean {
  return fs.existsSync(canary) && fs.existsSync(canaryFile) && fs.readFileSync(canaryFile, "utf8") === "must survive"
}

describe("sessionId cannot escape the sessions root", () => {
  it("the escape payload really does resolve to the canary", () => {
    // Guards the test itself: if the traversal stopped pointing at the canary,
    // every case below would pass for the wrong reason.
    expect(path.resolve(root, ESCAPE)).toBe(canary)
    expect(canaryIntact()).toBe(true)
  })

  it("deleteSession refuses to rm outside sessionsDir and keeps the canary", () => {
    expect(deleteSession(ESCAPE)).toBe(false)
    expect(canaryIntact()).toBe(true)
    for (const id of HOSTILE) {
      expect(deleteSession(id), `deleteSession(${JSON.stringify(id)})`).toBe(false)
      expect(canaryIntact(), `deleteSession(${JSON.stringify(id)}) damaged the canary`).toBe(true)
    }
  })

  it("loadConversation refuses to read outside sessionsDir", () => {
    // A real JSONL where the traversal lands, so a missing guard would actually
    // return entries rather than quietly returning [].
    fs.writeFileSync(path.join(canary, "log.jsonl"), JSON.stringify({ role: "user", content: "leaked" }) + "\n", "utf8")
    expect(loadConversation(ESCAPE)).toEqual([])
    for (const id of HOSTILE) {
      expect(loadConversation(id), `loadConversation(${JSON.stringify(id)})`).toEqual([])
    }
  })

  it("appendConversation refuses to mkdir/append outside sessionsDir", () => {
    for (const id of HOSTILE) {
      appendConversation(id, "user", "payload")
      expect(canaryIntact(), `appendConversation(${JSON.stringify(id)}) damaged the canary`).toBe(true)
    }
    expect(fs.existsSync(path.join(canary, "log.jsonl"))).toBe(false)
  })

  it("updateConversationToolResult refuses to rewrite a file outside sessionsDir", () => {
    // A real JSONL line carrying the target toolCallId, so the rewrite branch is
    // actually reached — unparseable content would leave `updated` false and the
    // assertion would pass whether or not the guard existed.
    const target = path.join(canary, "log.jsonl")
    const original = JSON.stringify({ role: "tool", toolCallId: "call-1", toolStatus: "running" }) + "\n"
    fs.writeFileSync(target, original, "utf8")
    for (const id of HOSTILE) {
      updateConversationToolResult(id, "call-1", { toolStatus: "completed" })
      expect(fs.readFileSync(target, "utf8"), `id ${JSON.stringify(id)}`).toBe(original)
    }
  })

  it("still accepts an ordinary session id", () => {
    // The guard is not "deny everything": valid ids must keep working, inside
    // the sessions root only.
    appendConversation("s-1", "user", "hello")
    expect(loadConversation("s-1").map((e) => e.content)).toEqual(["hello"])
    expect(deleteSession("never-existed")).toBe(true)
    // ...and the whole exercise stayed inside the sandbox.
    expect(fs.existsSync(path.join(root, "s-1"))).toBe(true)
  })
})
