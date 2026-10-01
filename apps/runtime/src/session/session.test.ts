/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Session persistence contract.
 *
 * The load-bearing case is the negative one: the system prompt must NOT reach
 * disk. It used to be written verbatim into the session file (plaintext, in
 * backups, in anything that later archived the file) and was never read back —
 * Agent rebuilds it from config via setSystemPrompt() right after load.
 */
import { describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Session } from "./session.js"

function tmpFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-session-")), name)
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
})
