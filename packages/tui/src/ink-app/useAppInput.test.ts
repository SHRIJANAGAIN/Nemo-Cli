/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, it, expect } from "vitest"
import type { Key } from "ink"
import { replayInputChunk, type AppInputHandler } from "./useAppInput.js"

const K = (over: Partial<Key> = {}): Key => ({
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
  ...over,
})

const collect = () => {
  const calls: Array<{ input: string; ret: boolean; sameKey: boolean }> = []
  const emit: AppInputHandler = (input, key) => {
    calls.push({ input, ret: key.return, sameKey: true })
  }
  return { calls, emit }
}

describe("replayInputChunk", () => {
  it("passes single chars through untouched", () => {
    const { calls, emit } = collect()
    const key = K()
    replayInputChunk("a", key, emit)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.input).toBe("a")
    expect(calls[0]!.ret).toBe(false)
  })

  it("splits a coalesced key+Enter chunk and re-derives Enter (the bug)", () => {
    // Observed live: in="i\r" return=false — Enter was lost.
    const { calls, emit } = collect()
    replayInputChunk("i\r", K(), emit)
    expect(calls.map((c) => c.input)).toEqual(["i", "\r"])
    expect(calls[0]!.ret).toBe(false)
    expect(calls[1]!.ret).toBe(true)
  })

  it("collapses CRLF to one Enter", () => {
    const { calls, emit } = collect()
    replayInputChunk("\r\n", K(), emit)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.input).toBe("\r")
    expect(calls[0]!.ret).toBe(true)
  })

  it("replays plain multi-char bursts per code point", () => {
    const { calls, emit } = collect()
    replayInputChunk("hi", K(), emit)
    expect(calls.map((c) => c.input)).toEqual(["h", "i"])
    expect(calls.every((c) => !c.ret)).toBe(true)
  })

  it("emits Enter mid-stream with trailing chars preserved", () => {
    const { calls, emit } = collect()
    replayInputChunk("a\rb", K(), emit)
    expect(calls.map((c) => c.input)).toEqual(["a", "\r", "b"])
    expect(calls.map((c) => c.ret)).toEqual([false, true, false])
  })

  it("does not split ctrl chords", () => {
    const { calls, emit } = collect()
    replayInputChunk("x\u0001", K({ ctrl: true }), emit)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.input).toBe("x\u0001")
  })

  it("keeps an already-flagged return", () => {
    const { calls, emit } = collect()
    replayInputChunk("\r", K({ return: true }), emit)
    expect(calls).toEqual([{ input: "\r", ret: true, sameKey: true }])
  })

  it("collapses pasted LF newlines to spaces (never submits)", () => {
    // The reported bug: multi-line paste submitted on the first \n.
    const { calls, emit } = collect()
    replayInputChunk("a\nb", K(), emit)
    expect(calls.map((c) => c.input)).toEqual(["a", " ", "b"])
    expect(calls.every((c) => !c.ret)).toBe(true)
  })

  it("collapses pasted CRLF newlines to spaces (never submits)", () => {
    const { calls, emit } = collect()
    replayInputChunk("a\r\nb", K(), emit)
    expect(calls.map((c) => c.input)).toEqual(["a", " ", "b"])
    expect(calls.every((c) => !c.ret)).toBe(true)
  })

  it("keeps pure CRLF as one Enter (not a paste)", () => {
    // No text around the break → keyboard Enter path, unchanged.
    const { calls, emit } = collect()
    replayInputChunk("\r\n", K(), emit)
    expect(calls.map((c) => c.input)).toEqual(["\r"])
    expect(calls[0]!.ret).toBe(true)
  })

  it("emits Shift-Tab (ESC[Z) atomically — one press, one toggle", () => {
    // Split into 3 emits, a plan toggle would fire thrice and land back
    // where it started (plus two phantom inputs). Atomic by design.
    const { calls, emit } = collect()
    replayInputChunk("[Z", K({ tab: true, shift: true }), emit)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.input).toBe("[Z")
  })
})
