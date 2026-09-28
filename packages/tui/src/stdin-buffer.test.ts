/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { StdinBuffer } from "./stdin-buffer.js"

type Recorder = { data: string[]; pastes: string[] }

const record = (buf: StdinBuffer): Recorder => {
  const out: Recorder = { data: [], pastes: [] }
  buf.on("data", (s) => out.data.push(s))
  buf.on("paste", (s) => out.pastes.push(s))
  return out
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe("StdinBuffer", () => {
  it("emits plain characters one at a time", () => {
    const buf = new StdinBuffer()
    const out = record(buf)
    buf.process("ab")
    expect(out.data).toEqual(["a", "b"])
    expect(buf.getBuffer()).toBe("")
  })

  it("accepts Buffer input", () => {
    const buf = new StdinBuffer()
    const out = record(buf)
    buf.process(Buffer.from("hi"))
    expect(out.data).toEqual(["h", "i"])
  })

  it("emits an empty data event for empty input on an empty buffer", () => {
    const buf = new StdinBuffer()
    const out = record(buf)
    buf.process(Buffer.alloc(0))
    expect(out.data).toEqual([""])
  })

  it("reassembles a CSI sequence split across chunks", async () => {
    const buf = new StdinBuffer({ timeout: 500 })
    const out = record(buf)
    buf.process("\x1b[")
    expect(out.data).toEqual([])
    expect(buf.getBuffer()).toBe("\x1b[")
    buf.process("A")
    expect(out.data).toEqual(["\x1b[A"])
    expect(buf.getBuffer()).toBe("")
    await sleep(20) // no delayed flush of an already-completed sequence
    expect(out.data).toEqual(["\x1b[A"])
  })

  it("decodes SS3, SGR mouse, and X10 mouse sequences", () => {
    const buf = new StdinBuffer()
    const out = record(buf)
    buf.process("\x1bOA")
    buf.process("\x1b[<0;12;34M")
    buf.process("\x1b[Mabc")
    expect(out.data).toEqual(["\x1bOA", "\x1b[<0;12;34M", "\x1b[Mabc"])
  })

  it("treats ESC followed by a plain character as two sequences", () => {
    const buf = new StdinBuffer()
    const out = record(buf)
    buf.process("\x1bxy")
    expect(out.data).toEqual(["\x1bx", "y"])
  })

  it("splits a double-escape prefix from a following CSI", () => {
    const buf = new StdinBuffer()
    const out = record(buf)
    buf.process("\x1b\x1b[A")
    expect(out.data).toEqual(["\x1b", "\x1b[A"])
  })

  it("emits a lone double-escape chunk whole when nothing follows", () => {
    const buf = new StdinBuffer()
    const out = record(buf)
    buf.process("\x1b\x1b")
    expect(out.data).toEqual(["\x1b\x1b"])
  })

  it("flushes an incomplete CSI after the sequence timeout", async () => {
    const buf = new StdinBuffer({ timeout: 15, escapeTimeout: 5_000 })
    const out = record(buf)
    buf.process("\x1b[")
    expect(out.data).toEqual([])
    await sleep(80)
    expect(out.data).toEqual(["\x1b["])
    expect(buf.getBuffer()).toBe("")
  })

  it("uses the shorter escape timeout for a bare ESC", async () => {
    const buf = new StdinBuffer({ timeout: 5_000, escapeTimeout: 10 })
    const out = record(buf)
    buf.process("\x1b")
    await sleep(60)
    expect(out.data).toEqual(["\x1b"])
  })

  it("flushes an incomplete OSC payload on timeout", async () => {
    const buf = new StdinBuffer({ timeout: 15 })
    const out = record(buf)
    buf.process("\x1b]0;partial")
    expect(out.data).toEqual([])
    await sleep(80)
    expect(out.data).toEqual(["\x1b]0;partial"])
  })

  it("flushes incomplete DCS and APC payloads on timeout", async () => {
    const buf = new StdinBuffer({ timeout: 15 })
    const out = record(buf)
    buf.process("\x1bPx")
    await sleep(80)
    buf.process("\x1b_P")
    await sleep(80)
    expect(out.data).toEqual(["\x1bPx", "\x1b_P"])
  })

  it("decodes complete OSC, DCS, and APC payloads immediately", () => {
    const buf = new StdinBuffer()
    const out = record(buf)
    buf.process("\x1b]0;title\x07")
    buf.process("\x1b]0;title\x1b\\")
    buf.process("\x1bPpayload\x1b\\")
    buf.process("\x1b_payload\x1b\\")
    expect(out.data).toEqual([
      "\x1b]0;title\x07",
      "\x1b]0;title\x1b\\",
      "\x1bPpayload\x1b\\",
      "\x1b_payload\x1b\\",
    ])
  })

  it("returns pending input from flush and an empty list when drained", () => {
    const buf = new StdinBuffer()
    buf.process("\x1b[1")
    expect(buf.flush()).toEqual(["\x1b[1"])
    expect(buf.flush()).toEqual([])
    expect(buf.getBuffer()).toBe("")
  })

  it("clear() discards pending input and any scheduled flush", async () => {
    const buf = new StdinBuffer({ timeout: 15 })
    const out = record(buf)
    buf.process("\x1b[")
    buf.clear()
    expect(buf.getBuffer()).toBe("")
    await sleep(60)
    expect(out.data).toEqual([])
    buf.process("x")
    expect(out.data).toEqual(["x"])
  })

  it("destroy() discards pending input", () => {
    const buf = new StdinBuffer()
    buf.process("\x1b[")
    buf.destroy()
    expect(buf.getBuffer()).toBe("")
  })

  it("emits a bracketed paste delivered in one chunk", () => {
    const buf = new StdinBuffer()
    const out = record(buf)
    buf.process("\x1b[200~hello\nworld\x1b[201~")
    expect(out.pastes).toEqual(["hello\nworld"])
    expect(out.data).toEqual([])
  })

  it("assembles a bracketed paste across chunks and resumes normal input", () => {
    const buf = new StdinBuffer()
    const out = record(buf)
    buf.process("\x1b[200~hel")
    expect(out.pastes).toEqual([])
    buf.process("lo\x1b[201~z")
    expect(out.pastes).toEqual(["hello"])
    expect(out.data).toEqual(["z"])
  })

  it("emits input arriving before the paste marker, then the paste", () => {
    const buf = new StdinBuffer()
    const out = record(buf)
    buf.process("ab\x1b[200~pasted\x1b[201~tail")
    expect(out.data).toEqual(["a", "b", "t", "a", "i", "l"])
    expect(out.pastes).toEqual(["pasted"])
  })

  it("clears paste mode when input is discarded mid-paste", () => {
    const buf = new StdinBuffer()
    const out = record(buf)
    buf.process("\x1b[200~partial")
    buf.clear()
    buf.process("z")
    expect(out.pastes).toEqual([])
    expect(out.data).toEqual(["z"])
  })
})
