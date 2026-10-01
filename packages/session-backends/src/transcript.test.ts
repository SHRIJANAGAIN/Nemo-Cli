import { describe, expect, it, beforeEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  createTranscript,
  appendContext,
  appendWire,
  contextFile,
  readState,
  listTranscripts,
  isEmptyTranscript,
} from "./transcript.js"

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-tx-"))
  process.env.TRAYAMBAK_SESSIONS_DIR = dir
})

describe("transcript store", () => {
  it("creates context+wire+state files", () => {
    const { id } = createTranscript(process.cwd())
    expect(isEmptyTranscript(id)).toBe(true)
    appendContext(id, { role: "user", content: "hello" })
    appendWire(id, { type: "TurnBegin", user_input: "hello world" })
    expect(isEmptyTranscript(id)).toBe(false)
    expect(readState(id)?.workDir).toBe(process.cwd())
  })

  it("refuses system-role records (fail-closed, mirrors Session.save)", () => {
    const { id } = createTranscript(process.cwd())
    appendContext(id, { role: "system", content: "SNEAKY PROMPT BODY" })
    appendContext(id, { role: "user", content: "hello" })
    const raw = fs.readFileSync(contextFile(id), "utf8")
    expect(raw).not.toContain("SNEAKY PROMPT BODY")
    expect(raw).toContain("hello")
  })

  it("lists non-empty transcripts newest first", () => {
    const a = createTranscript(process.cwd())
    appendContext(a.id, { role: "user" })
    const b = createTranscript(process.cwd())
    appendContext(b.id, { role: "user" })
    const ids = listTranscripts().map((t) => t.id)
    expect(ids).toContain(a.id)
    expect(ids).toContain(b.id)
  })
})
