import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { logger } from "./logger.js"

let dir: string
let logFile: string
const savedEnv = {
  NEMO_LOG: process.env.NEMO_LOG,
  NEMO_LOG_FILE: process.env.NEMO_LOG_FILE,
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-logger-"))
  logFile = path.join(dir, "logs", "nemo.log")
  process.env.NEMO_LOG = "silent"
  process.env.NEMO_LOG_FILE = logFile
})

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

function readLines(): Array<Record<string, unknown>> {
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

describe("logger file sink", () => {
  it("writes structured JSON lines with ts/level/msg", () => {
    logger.info("hello world", { command: "serve", port: 8080 })
    const lines = readLines()
    expect(lines).toHaveLength(1)
    expect(lines[0].level).toBe("info")
    expect(lines[0].msg).toBe("hello world")
    expect(lines[0].command).toBe("serve")
    expect(lines[0].port).toBe(8080)
    expect(typeof lines[0].ts).toBe("string")
    expect(Number.isNaN(Date.parse(String(lines[0].ts)))).toBe(false)
  })
  it("appends across calls", () => {
    logger.debug("one")
    logger.error("two")
    const lines = readLines()
    expect(lines.map((l) => l.level)).toEqual(["debug", "error"])
  })
  it("never throws on unwritable paths", () => {
    process.env.NEMO_LOG_FILE = path.join(dir, "x", String(Date.now() % 3))
    // a path under a FILE would fail mkdir; use an invalid character path instead
    process.env.NEMO_LOG_FILE = "\u0000invalid"
    expect(() => logger.error("still fine")).not.toThrow()
  })
  it("rotates the file at 1MB", () => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fs.writeFileSync(logFile, "x".repeat(1024 * 1024 + 10), "utf8")
    logger.warn("after rotation")
    expect(fs.existsSync(logFile + ".old")).toBe(true)
    expect(readLines().some((l) => l.msg === "after rotation")).toBe(true)
  })
  it("disables file logging with NEMO_LOG_FILE=off", () => {
    process.env.NEMO_LOG_FILE = "off"
    expect(() => logger.error("nope")).not.toThrow()
    expect(fs.existsSync(logFile)).toBe(false)
  })
  it("masks credentials embedded mid-string before they reach the disk sink (#51)", () => {
    // git-style remote URL with the token in the userinfo — the shape that
    // previously landed raw because redactLogValue has no embedded pass.
    logger.warn("push failed for https://x-access-token:ghp_abcdefghij0123456789@github.com/o/r.git", {
      hint: "retry with sk-abcdefghijklmnop0123456789",
      url: "postgres://alice:s3cr3t@db.internal:5432/app",
    })
    const raw = fs.readFileSync(logFile, "utf8")
    expect(raw).not.toContain("ghp_abcdefghij0123456789")
    expect(raw).not.toContain("sk-abcdefghijklmnop0123456789")
    expect(raw).not.toContain("s3cr3t")
    // …and the useful context survives: repo path and db host stay visible.
    expect(raw).toContain("github.com/o/r.git")
    expect(raw).toContain("db.internal:5432/app")
    const line = readLines()[0]
    expect(String(line.msg)).toContain("[REDACTED]")
  })
})
