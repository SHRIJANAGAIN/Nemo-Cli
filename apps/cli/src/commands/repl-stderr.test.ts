/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * REPL stderr capture contract: tee is live and byte-identical (the console
 * rendering must not change versus the old inherit), the disk sink gets an
 * exit-headed redacted tail under the 256KB cap, silent children write
 * nothing, and capture failures can never throw into the spawn path.
 */

import { afterEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { randomUUID } from "crypto"
import { createStderrCapture } from "./repl-stderr.js"

const dirs: string[] = []

function tmpLog(): string {
  const dir = path.join(os.tmpdir(), "nemo-stderr-test-" + randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  return path.join(dir, "repl-stderr.log")
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("createStderrCapture", () => {
  it("tees every chunk byte-identically and writes an exit-headed tail", () => {
    const log = tmpLog()
    const teed: Buffer[] = []
    const cap = createStderrCapture({ logPath: log, tee: (c) => teed.push(c) })

    const fatal = "FATAL ERROR: Something went seriously wrong\n    at boom (x.js:1)\n"
    cap.write(fatal)
    cap.write(Buffer.from("tail line\n"))

    // Live sink saw the exact bytes the child wrote (inherit parity).
    expect(Buffer.concat(teed).toString("utf8")).toBe(fatal + "tail line\n")

    const written = cap.finish({ code: 134, signal: null })
    expect(written).toBe(log)
    const file = fs.readFileSync(log, "utf8")
    expect(file).toContain("repl-stderr exit code=134 signal=null")
    expect(file).toContain("FATAL ERROR: Something went seriously wrong")
    expect(file).toContain("tail line")
  })

  it("writes nothing for a silent child and reports null", () => {
    const log = tmpLog()
    const cap = createStderrCapture({ logPath: log })
    expect(cap.finish({ code: 0, signal: null })).toBeNull()
    expect(fs.existsSync(log)).toBe(false)
  })

  it("keeps the disk sink disabled (logPath null) while still teeing live", () => {
    const teed: string[] = []
    const cap = createStderrCapture({ logPath: null, tee: (c) => teed.push(c.toString("utf8")) })
    cap.write("warning: noisy but not fatal\n")
    expect(teed).toEqual(["warning: noisy but not fatal\n"])
    expect(cap.finish({ code: 1, signal: null })).toBeNull()
  })

  it("caps the retained tail at maxBytes, newest bytes win", () => {
    const log = tmpLog()
    const cap = createStderrCapture({ logPath: log, maxBytes: 64 })
    cap.write("OLDEST-MARKER " + "a".repeat(80) + "\n")
    cap.write("NEWEST-MARKER " + "b".repeat(20) + "\n")
    expect(cap.finish({ code: 134, signal: null })).toBe(log)
    const file = fs.readFileSync(log, "utf8")
    expect(file).toContain("NEWEST-MARKER")
    // The header is not part of the cap math; the tail slice is.
    const tail = file.slice(file.indexOf("exit code"))
    expect(file).not.toContain("OLDEST-MARKER")
    expect(tail.length).toBeLessThan(64 + 80)
  })

  it("redacts the disk sink through the platform chokepoint", () => {
    const log = tmpLog()
    const cap = createStderrCapture({ logPath: log })
    cap.write("crash context key=nvapi-ABCDEFGH12345678 done\n")
    expect(cap.finish({ code: 134, signal: null })).toBe(log)
    const file = fs.readFileSync(log, "utf8")
    expect(file).not.toContain("nvapi-ABCDEFGH12345678")
    expect(file).toContain("[REDACTED]")
    expect(file).toContain("crash context")
  })

  it("is idempotent across repeated exit notifications", () => {
    const log = tmpLog()
    const cap = createStderrCapture({ logPath: log })
    cap.write("only once\n")
    const first = cap.finish({ code: 134, signal: null })
    const second = cap.finish({ code: 134, signal: null })
    expect(second).toBe(first)
    const file = fs.readFileSync(log, "utf8")
    expect(file.match(/repl-stderr exit code/g)).toHaveLength(1)
  })

  it("never throws from a failing sink (capture is diagnostics, not a crash path)", () => {
    // Make appendFileSync fail deterministically: logPath's parent exists as
    // a FILE, so mkdirSync(dirname) throws ENOTDIR inside finish()'s guard.
    const blocker = path.join(os.tmpdir(), "nemo-stderr-block-" + randomUUID())
    fs.writeFileSync(blocker, "file, not a directory\n")
    dirs.push(blocker)
    const cap = createStderrCapture({
      logPath: path.join(blocker, "logs", "repl-stderr.log"),
      tee: () => {},
    })
    expect(() => cap.write("data\n")).not.toThrow()
    expect(cap.finish({ code: 134, signal: null })).toBeNull()
  })
})
