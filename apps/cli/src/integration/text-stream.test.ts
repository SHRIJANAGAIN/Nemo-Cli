/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { TextStreamService } from "./text-stream.js"

/**
 * The service slices text into ≤100-char chunks, forwards them to onChunk,
 * and accumulates them in a bounded ring so onComplete/getBuffered can
 * replay the tail. Chunking uses /[\s\S]/ so every character survives: the
 * original /./ regex never matched "\n" and String.match keeps only matched
 * spans, so multi-line text silently lost its newlines ("ab\ncd" → "abcd") —
 * pinned closed by the multiline tests below.
 */
describe("TextStreamService chunking", () => {
  it("emits short text as a single chunk and completes with it", () => {
    const service = new TextStreamService()
    const chunks: string[] = []
    let completed: string | null = null
    service.stream("hello world", {
      onChunk: (chunk) => chunks.push(chunk),
      onComplete: (full) => {
        completed = full
      },
    })
    expect(chunks).toEqual(["hello world"])
    expect(completed).toBe("hello world")
    expect(service.getBuffered()).toBe("hello world")
  })

  it("slices long text into 100-character chunks in order", () => {
    const service = new TextStreamService()
    const chunks: string[] = []
    const text = "x".repeat(250)
    service.stream(text, { onChunk: (chunk) => chunks.push(chunk) })
    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 100, 50])
    expect(chunks.join("")).toBe(text)
  })

  it("accumulates across stream() calls until cleared", () => {
    const service = new TextStreamService()
    service.stream("one")
    service.stream("two")
    expect(service.getBuffered()).toBe("onetwo")
    service.clear()
    expect(service.getBuffered()).toBe("")
  })

  it("streams without any callbacks attached", () => {
    const service = new TextStreamService()
    expect(() => service.stream("no callbacks")).not.toThrow()
    expect(service.getBuffered()).toBe("no callbacks")
  })

  it("preserves newlines: multi-line text round-trips byte-for-byte", () => {
    const service = new TextStreamService()
    const chunks: string[] = []
    let completed: string | null = null
    const text = "line one\nline two\n\nline four"
    service.stream(text, {
      onChunk: (chunk) => chunks.push(chunk),
      onComplete: (full) => {
        completed = full
      },
    })
    // Regression: /./ chunking dropped every bare newline, streaming
    // "line oneline twoline four".
    expect(chunks.join("")).toBe(text)
    expect(completed).toBe(text)
    expect(service.getBuffered()).toBe(text)
  })

  it("keeps a newline sitting exactly at a 100-char chunk boundary", () => {
    const service = new TextStreamService()
    const chunks: string[] = []
    const text = "x".repeat(100) + "\n" + "tail"
    service.stream(text, { onChunk: (chunk) => chunks.push(chunk) })
    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 5])
    expect(chunks.join("")).toBe(text)
  })

  it("handles empty input: one empty chunk and an empty completion", () => {
    const service = new TextStreamService()
    const chunks: string[] = []
    let completed: string | null = null
    service.stream("", {
      onChunk: (chunk) => chunks.push(chunk),
      onComplete: (full) => {
        completed = full
      },
    })
    expect(chunks).toEqual([""])
    expect(completed).toBe("")
    expect(service.getBuffered()).toBe("")
  })
})

describe("TextStreamService buffer bound", () => {
  it("keeps only the newest bufferSize chunks and reports them as the completion text", () => {
    const service = new TextStreamService()
    // The bound counts CHUNKS, not bytes: a size of 2 retains 2 × 100 chars.
    service.setBufferSize(2)
    const text = "abcdefghij".repeat(50) // 500 chars → 5 chunks
    let completed: string | null = null
    service.stream(text, {
      onComplete: (full) => {
        completed = full
      },
    })
    expect(service.getBuffered()).toBe(text.slice(300))
    expect(completed).toBe(text.slice(300))
  })

  it("trims already-buffered chunks when the bound shrinks mid-stream", () => {
    const service = new TextStreamService()
    service.stream("first-chunk")
    service.stream("second-chunk")
    expect(service.getBuffered()).toBe("first-chunksecond-chunk")
    service.setBufferSize(1)
    service.stream("third-chunk")
    // The push overflows the new bound, so both older chunks are evicted.
    expect(service.getBuffered()).toBe("third-chunk")
  })

  it("a bound of zero evicts every chunk as it arrives", () => {
    const service = new TextStreamService()
    service.setBufferSize(0)
    service.stream("gone")
    expect(service.getBuffered()).toBe("")
  })
})
