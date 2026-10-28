/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Session persistence contract.
 *
 * The load-bearing case is the negative one: the system prompt must NOT reach
 * disk. It used to be written verbatim into the session file (plaintext, in
 * backups, in anything that later archived the file) and was never read back —
 * Agent rebuilds it from config via setSystemPrompt() right after load.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Session } from "./session.js"

afterEach(() => {
  vi.restoreAllMocks()
})

function tmpFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nemo-session-")), name)
}

describe("Session.save", () => {
  it("round-trips messages", () => {
    const file = tmpFile("session.json")
    const original = new Session()
    original.add({ role: "user", content: "hello" })
    original.add({ role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "end_turn" })
    original.save(file)

    const loaded = Session.load(file)
    expect(loaded?.messages).toHaveLength(2)
    expect(loaded?.messages[0]).toEqual({ role: "user", content: "hello" })
  })

  it("never writes the system prompt to disk", () => {
    const file = tmpFile("session.json")
    const session = new Session()
    session.setSystemPrompt("SECRET SYSTEM PROMPT: you may run bash and write files")
    session.add({ role: "user", content: "hi" })
    session.save(file)

    const raw = fs.readFileSync(file, "utf8")
    expect(raw).not.toContain("SECRET SYSTEM PROMPT")
    expect(raw).not.toContain("system")
    expect(Object.keys(JSON.parse(raw) as Record<string, unknown>)).toEqual(["messages"])
  })

  it("strips a system-role message that lands in messages (fail-closed)", () => {
    const file = tmpFile("session.json")
    const session = new Session()
    session.add({ role: "user", content: "hi" })
    session.add({ role: "system", content: "SNEAKY PROMPT BODY" })
    session.save(file)

    const raw = fs.readFileSync(file, "utf8")
    expect(raw).not.toContain("SNEAKY PROMPT BODY")
    expect(Session.load(file)?.messages).toEqual([{ role: "user", content: "hi" }])
  })

  it("keeps the prompt in memory for the run that needs it", () => {
    const session = new Session()
    session.setSystemPrompt("prompt body")
    expect(session.systemContext).toBe("prompt body")
    expect(session.toWireMessages()[0]).toEqual({ role: "system", content: "prompt body" })
  })
})

describe("Session.load", () => {
  it("refuses remote UNC paths without touching the network", () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never)
    expect(Session.load("\\\\192.0.2.1\\share\\s.json")).toBeNull()
    expect(String(errSpy.mock.calls[0]?.[0] ?? "")).toContain("refusing to load session")
    errSpy.mockRestore()
  })

  it("refuses to save to remote UNC paths", () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never)
    const session = new Session()
    session.add({ role: "user", content: "hi" })
    expect(() => session.save("\\\\192.0.2.1\\share\\s.json")).not.toThrow()
    expect(String(errSpy.mock.calls[0]?.[0] ?? "")).toContain("refusing to save session")
    errSpy.mockRestore()
  })

  it("discards a legacy persisted system prompt instead of restoring it", () => {
    const file = tmpFile("legacy.json")
    fs.writeFileSync(
      file,
      JSON.stringify({
        system: "STALE PROMPT FROM AN OLD BUILD",
        messages: [{ role: "user", content: "hi" }],
      }),
      "utf8",
    )

    const loaded = Session.load(file)
    expect(loaded?.systemContext).toBe("")
    expect(loaded?.messages).toHaveLength(1)
  })

  it("returns null for a missing file and survives a corrupt one", () => {
    expect(Session.load(path.join(os.tmpdir(), "definitely-not-here-9182.json"))).toBeNull()
    const corrupt = tmpFile("corrupt.json")
    fs.writeFileSync(corrupt, "{ not json", "utf8")
    expect(Session.load(corrupt)).toBeNull()
  })

  it("tolerates a file with no messages key", () => {
    const file = tmpFile("empty.json")
    fs.writeFileSync(file, JSON.stringify({}), "utf8")
    const loaded = Session.load(file)
    expect(loaded).not.toBeNull()
    expect(loaded?.messages).toEqual([])
  })

  /**
   * The transcripts that actually exist on disk are not the shape this class
   * writes. `nemo resume <id>` resolves `~/.nemo/sessions/<id>`, and the wire
   * recorder had filled those files with JSONL — one `{ts, message}` row per
   * line. `Session.load` did a whole-file `JSON.parse`, threw, returned null,
   * and every real session reported "no transcript found".
   */
  it("reads a JSONL wire transcript", () => {
    const file = tmpFile("wire.jsonl")
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ ts: 1, message: { role: "system", content: "OLD PROMPT" } }),
        JSON.stringify({ ts: 2, message: { role: "user", content: "hello" } }),
        JSON.stringify({
          ts: 3,
          message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "end_turn" },
        }),
        "not json at all",
        "",
      ].join("\n"),
      "utf8",
    )

    const loaded = Session.load(file)
    expect(loaded?.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(loaded?.systemContext).toBe("")
  })

  it("reads a one-line wire transcript, which is also valid JSON", () => {
    // A short session leaves exactly one row. Whole-file JSON.parse succeeds on
    // that and found no `messages` key, so the transcript reported empty and
    // the resume stopped before reaching the wire loader.
    const file = tmpFile("wire-one.jsonl")
    fs.writeFileSync(file, JSON.stringify({ ts: 1, message: { role: "user", content: "only turn" } }), "utf8")

    const loaded = Session.load(file)
    expect(loaded?.messages).toHaveLength(1)
    expect((loaded?.messages[0] as { content: string }).content).toBe("only turn")
  })

  it("reads bare JSONL rows that carry no ts/message wrapper", () => {
    const file = tmpFile("wire-bare.jsonl")
    fs.writeFileSync(file, [JSON.stringify({ role: "user", content: "a" }), JSON.stringify({ role: "user", content: "b" })].join("\n"), "utf8")

    expect(Session.load(file)?.messages.map((m) => (m as { content: string }).content)).toEqual(["a", "b"])
  })

  it("returns null rather than an empty session for a transcript with nothing restorable", () => {
    const file = tmpFile("wire-junk.jsonl")
    fs.writeFileSync(file, [JSON.stringify({ ts: 1, message: { role: "system", content: "PROMPT" } }), "{ broken"].join("\n"), "utf8")

    expect(Session.loadWire(file)).toBeNull()
  })
})
