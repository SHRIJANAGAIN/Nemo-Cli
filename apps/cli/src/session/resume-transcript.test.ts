/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * `/resume` must hand the agent the REAL transcript, so these run against real
 * files written by `Session.save` — no stubs, no in-memory stand-in for the
 * store.
 */
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Session } from "../../../runtime/src/session/session.js"
import { isTranscriptTarget, loadTranscript, sessionsDir, transcriptPathFor } from "./resume-transcript.js"

let dir = ""
let priorDir: string | undefined

beforeEach(() => {
  priorDir = process.env.NEMO_SESSIONS_DIR
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-resume-"))
  process.env.NEMO_SESSIONS_DIR = dir
})

afterEach(() => {
  if (priorDir === undefined) delete process.env.NEMO_SESSIONS_DIR
  else process.env.NEMO_SESSIONS_DIR = priorDir
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Write a genuine transcript the way the agent does. */
function writeTranscript(id: string, texts: string[]): string {
  const s = new Session()
  s.add({ role: "user", content: texts[0] ?? "hello" })
  if (texts.length > 1) {
    s.add({
      role: "assistant",
      content: [{ type: "text", text: texts[1] ?? "hi" }],
      stopReason: "end_turn",
    })
  }
  if (texts.length > 2) s.add({ role: "user", content: texts[2] ?? "more" })
  const file = path.join(dir, id)
  s.save(file)
  return file
}

describe("transcriptPathFor", () => {
  it("resolves an id to a file inside the sessions directory", () => {
    expect(transcriptPathFor("session-abc")).toBe(path.join(dir, "session-abc"))
  })

  it("rejects traversal instead of joining it", () => {
    // The id comes from the command line. Without this, `/resume ../../x` is an
    // arbitrary-file read.
    for (const bad of ["../secrets", "..", "a/b", "a\\b", "..\\..\\x"]) {
      expect(() => transcriptPathFor(bad), bad).toThrow(/Invalid session id/)
    }
  })

  it("rejects an empty or non-string id", () => {
    expect(() => transcriptPathFor("")).toThrow(/Invalid session id/)
    expect(() => transcriptPathFor(undefined as unknown as string)).toThrow(/Invalid session id/)
  })

  it("keeps the result inside the sessions directory", () => {
    expect(path.dirname(transcriptPathFor("session-1"))).toBe(path.resolve(dir))
  })

  it("falls back to a home directory when the env var is absent", () => {
    delete process.env.NEMO_SESSIONS_DIR
    expect(sessionsDir()).toBe(path.join(os.homedir(), ".nemo", "sessions"))
  })
})

describe("loadTranscript", () => {
  it("returns the file and the real message count for a saved session", () => {
    const file = writeTranscript("session-live", ["first ask", "first answer", "second ask"])
    const result = loadTranscript("session-live")
    expect(isTranscriptTarget(result)).toBe(true)
    if (!isTranscriptTarget(result)) return
    expect(result.file).toBe(file)
    expect(result.messageCount).toBe(3)
  })

  it("actually carries the history — the point of the whole change", () => {
    writeTranscript("session-hist", ["remember the milk", "noted"])
    const result = loadTranscript("session-hist")
    if (!isTranscriptTarget(result)) throw new Error("expected a transcript")
    // Re-read through the same path Agent uses, proving the resumed session
    // would actually contain the earlier turns.
    const restored = Session.load(result.file)
    expect(restored?.messages.map((m) => (m.role === "user" ? m.content : "")).join("|")).toContain("remember the milk")
  })

  it("reports a missing transcript instead of pretending to resume", () => {
    const result = loadTranscript("session-nope")
    expect(isTranscriptTarget(result)).toBe(false)
    if (isTranscriptTarget(result)) return
    expect(result.error).toContain("no transcript found")
  })

  it("refuses an empty transcript rather than resuming nothing", () => {
    new Session().save(path.join(dir, "session-empty"))
    const result = loadTranscript("session-empty")
    expect(isTranscriptTarget(result)).toBe(false)
    if (isTranscriptTarget(result)) return
    expect(result.error).toContain("empty transcript")
  })

  it("reports a corrupt transcript as an error, not a silent empty resume", () => {
    fs.writeFileSync(path.join(dir, "session-bad"), "{not json", "utf8")
    const result = loadTranscript("session-bad")
    expect(isTranscriptTarget(result)).toBe(false)
  })

  it("rejects a traversal id without touching the filesystem", () => {
    fs.writeFileSync(path.join(dir, "outside"), "secret", "utf8")
    const result = loadTranscript("../outside")
    expect(isTranscriptTarget(result)).toBe(false)
    if (isTranscriptTarget(result)) return
    expect(result.error).toContain("Invalid session id")
  })

  /**
   * The shape that is actually on disk. Every session the recorder wrote is
   * `<id>.jsonl`; resolving only the bare `<id>` made `nemo resume <uuid>` say
   * "no transcript found" for sessions the picker listed.
   */
  it("finds a wire transcript stored as <id>.jsonl", () => {
    const id = "11112222-3333-4444-5555-666677778888"
    fs.writeFileSync(
      path.join(dir, `${id}.jsonl`),
      [
        JSON.stringify({ ts: 1, message: { role: "system", content: "PROMPT" } }),
        JSON.stringify({ ts: 2, message: { role: "user", content: "did it resume?" } }),
      ].join("\n"),
      "utf8",
    )

    const result = loadTranscript(id)
    expect(isTranscriptTarget(result)).toBe(true)
    if (!isTranscriptTarget(result)) return
    expect(result.file).toBe(path.join(dir, `${id}.jsonl`))
    expect(result.messageCount).toBe(1)
  })

  it("prefers the bare transcript when both shapes exist", () => {
    const id = "session-both"
    writeTranscript(id, ["the real one"])
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ ts: 1, message: { role: "user", content: "stale" } }), "utf8")

    const result = loadTranscript(id)
    if (!isTranscriptTarget(result)) throw new Error("expected a transcript")
    expect(result.file).toBe(path.join(dir, id))
  })

  it("still reports an empty transcript when the only candidate is empty", () => {
    const id = "session-only-empty"
    new Session().save(path.join(dir, id))
    const result = loadTranscript(id)
    expect(isTranscriptTarget(result)).toBe(false)
    if (isTranscriptTarget(result)) return
    expect(result.error).toContain("empty transcript")
  })
})
