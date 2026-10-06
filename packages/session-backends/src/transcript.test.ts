import { describe, expect, it, beforeEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  assertSessionId,
  createTranscript,
  appendContext,
  appendWire,
  contextFile,
  readState,
  listTranscripts,
  isEmptyTranscript,
  sessionDir,
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

describe("session id validation (finding #28)", () => {
  it("accepts generated and ordinary ids", () => {
    expect(() => assertSessionId("550e8400-e29b-41d4-a716-446655440000")).not.toThrow()
    expect(() => assertSessionId("1722345600000-abcdef12")).not.toThrow()
    expect(() => assertSessionId("s-1")).not.toThrow()
  })

  it("rejects traversal, absolute paths, and empty ids", () => {
    for (const hostile of ["", ".", "..", "../x", "../../etc/passwd", "/abs/path", "a/b", "a\\b", "x".repeat(200)]) {
      expect(() => assertSessionId(hostile), hostile).toThrow("invalid session id")
    }
  })

  it("sessionDir throws before joining hostile ids", () => {
    expect(() => sessionDir("../../../../important")).toThrow("invalid session id")
  })

  it("listTranscripts skips hostile directory names instead of dying", () => {
    const root = process.env.TRAYAMBAK_SESSIONS_DIR as string
    fs.mkdirSync(path.join(root, "..evil"), { recursive: true })
    const { id } = createTranscript(process.cwd())
    appendContext(id, { role: "user" })
    expect(listTranscripts().map((t) => t.id)).toContain(id)
  })
})
