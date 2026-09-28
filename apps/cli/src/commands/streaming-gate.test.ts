/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { StreamingGate } from "./streaming-gate.js"

let tmp = ""
let gate: StreamingGate
const dirs: string[] = []

const benign = "Hello world. How are you? Fine!"

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-gate-"))
  dirs.push(tmp)
  // A non-existent script path keeps the optional python daemon out of the
  // picture so every test exercises the built-in JS checker.
  gate = new StreamingGate(tmp, path.join(tmp, "no-such-gate-script.py"))
})

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe("StreamingGate lifecycle", () => {
  it("starts, refuses to start twice, and stops cleanly", async () => {
    expect(await gate.start()).toBe(true)
    expect(await gate.start({ ngramRepeat: 2 })).toBe(true) // alive guard

    await gate.stop()
    expect(await gate.ingest(benign)).toBeNull()
    expect(await gate.finalize()).toBeNull()
    expect(await gate.verify(tmp, true)).toBeNull()

    await gate.stop() // second stop is a no-op
  })

  it("derives the default script path under rootDir without a daemon", async () => {
    const defaultGate = new StreamingGate(tmp)
    expect(await defaultGate.start()).toBe(true)
    expect(await defaultGate.ingest(benign)).toBeNull()
    await defaultGate.stop()
  })

  it("ignores input before start and while disabled", async () => {
    expect(await gate.ingest(benign)).toBeNull()

    await gate.start()
    gate.setEnabled(false)
    expect(await gate.ingest(benign)).toBeNull()

    gate.setEnabled(true)
    expect(await gate.ingest(benign)).toBeNull()
  })
})

describe("StreamingGate JS checker", () => {
  beforeEach(async () => {
    await gate.start()
  })

  it("cuts on a repeated character run", async () => {
    expect(await gate.ingest("x")).toBeNull()
    const decision = await gate.ingest("aaaaaa")
    expect(decision).toMatchObject({
      decision: "cut",
      level: "warn",
      cutAtChar: 1,
      charPos: 7,
      totalChars: 7,
      details: { type: "char_run" },
    })
    expect(decision?.reason).toContain("character run detected")
  })

  it("cuts when identical chunks repeat", async () => {
    expect(await gate.ingest("AB")).toBeNull()
    const decision = await gate.ingest("AB")
    expect(decision).toMatchObject({
      decision: "cut",
      cutAtChar: 0,
      details: { type: "repeat_loop" },
    })
    expect(decision?.reason).toBe("repeated identical chunks (loop detected)")
  })

  it("cuts on a numeric run", async () => {
    expect(await gate.ingest("x")).toBeNull()
    const decision = await gate.ingest("11111")
    expect(decision).toMatchObject({
      decision: "cut",
      cutAtChar: 1,
      details: { type: "digit_run" },
    })
    expect(decision?.reason).toContain("numeric run detected")
  })

  it("cuts once the buffer exceeds 12000 characters", async () => {
    const decision = await gate.ingest("ab".repeat(6001))
    expect(decision).toMatchObject({
      decision: "cut",
      details: { type: "max_length" },
    })
    expect(decision?.reason).toBe("output too long")
    expect(decision?.totalChars).toBeGreaterThan(12000)
  })

  it("cuts when the same word repeats six times at the tail", async () => {
    const decision = await gate.ingest("go go go go go go")
    expect(decision).toMatchObject({
      decision: "cut",
      details: { type: "word_repeat" },
    })
    expect(decision?.reason).toContain("word repetition detected ('go' x6)")
  })

  it("cuts on a repeated phrase of at least four words long", async () => {
    const decision = await gate.ingest("alpha beta gamma ".repeat(7))
    expect(decision).toMatchObject({
      decision: "cut",
      details: { type: "phrase_repeat" },
    })
    expect(decision?.reason).toContain("phrase repetition detected")
    expect(decision?.details.count as number).toBeGreaterThanOrEqual(4)
    expect(decision?.cutAtChar).toBeGreaterThanOrEqual(0)
  })

  it("passes benign prose through without a decision", async () => {
    expect(await gate.ingest("Hello world.")).toBeNull()
    expect(await gate.ingest(" Second sentence!")).toBeNull()
    expect(await gate.finalize()).toBeNull()
  })
})

describe("StreamingGate.verify JS fallback", () => {
  const writePkg = (dir: string, content: string): string => {
    fs.mkdirSync(dir, { recursive: true })
    const pkg = path.join(dir, "package.json")
    fs.writeFileSync(pkg, content, "utf8")
    return dir
  }

  it("is null before start", async () => {
    expect(await gate.verify(tmp, true)).toBeNull()
  })

  it("skips typecheck and tests when nothing is present", async () => {
    await gate.start()
    const report = await gate.verify(path.join(tmp, "empty"), true)
    expect(report?.steps).toHaveLength(2)
    expect(report?.steps[0]).toMatchObject({ name: "typecheck", status: "skip" })
    expect(report?.steps[0]?.output_tail).toBe("no tsconfig.json")
    expect(report?.steps[1]).toMatchObject({ name: "test", status: "skip", output_tail: "skipped" })
    expect(report?.overall).toBe("pass")
  })

  it("skips the test step when package.json has no test script", async () => {
    await gate.start()
    const dir = writePkg(path.join(tmp, "noscript"), JSON.stringify({ scripts: {} }))
    const report = await gate.verify(dir, false)
    expect(report?.steps[1]).toMatchObject({ name: "test", status: "skip" })
    expect(report?.steps[1]?.output_tail).toBe("no test script")
    expect(report?.overall).toBe("pass")
  })

  it("skips the test step when package.json is unreadable", async () => {
    await gate.start()
    const dir = writePkg(path.join(tmp, "broken"), "{ not json")
    const report = await gate.verify(dir, false)
    expect(report?.steps[1]).toMatchObject({ name: "test", status: "skip" })
    expect(report?.steps[1]?.output_tail).toBe("could not read package.json")
    expect(report?.overall).toBe("pass")
  })

  it("records a passing npm test run", async () => {
    await gate.start()
    const dir = writePkg(
      path.join(tmp, "passing"),
      JSON.stringify({
        name: "gate-fixture",
        version: "0.0.0",
        scripts: { test: 'node -e "process.exit(0)"' },
      }),
    )
    const report = await gate.verify(dir, false)
    expect(report?.steps[1]).toMatchObject({ name: "test", command: "npm test", status: "pass" })
    expect(report?.overall).toBe("pass")
  }, 60_000)

  it("records a failing npm test run and reports overall fail", async () => {
    await gate.start()
    const dir = writePkg(
      path.join(tmp, "failing"),
      JSON.stringify({
        name: "gate-fixture",
        version: "0.0.0",
        scripts: { test: 'node -e "process.exit(1)"' },
      }),
    )
    const report = await gate.verify(dir, false)
    expect(report?.steps[1]).toMatchObject({ name: "test", command: "npm test", status: "fail" })
    expect(typeof report?.steps[1]?.output_tail).toBe("string")
    expect(report?.overall).toBe("fail")
  }, 60_000)
})
