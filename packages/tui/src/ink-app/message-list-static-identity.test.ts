/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * The frame-clone regression, pinned.
 *
 * Ink's <Static> treats a CHANGED `items` array as new static content: it runs
 * `log.clear()` and reprints the whole frame at the cursor (ink.js:779-786).
 * A fresh array identity on every render therefore reprinted the frame once
 * per repaint — the clock alone is 500ms — and every reprint landed at the
 * cursor instead of erasing the previous frame, so the frames stacked up. That
 * is the "resize karne me frames ki clone bane rhae" report.
 *
 * The contract these tests pin: re-rendering with unchanged history must hand
 * Ink the SAME array, and the printed prefix must still be appended correctly
 * when it genuinely grows.
 */

import { PassThrough } from "node:stream"
import React, { useState } from "react"
import { render, type Instance } from "ink"
import { describe, expect, it } from "vitest"
import { MessageList } from "./MessageList.js"
import type { TrayambakMessage } from "./types.js"

function openStdio(columns = 120, rows = 30) {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => {},
    ref: () => {},
    unref: () => {},
  }) as unknown as NodeJS.ReadStream
  let captured = ""
  const rawOut = new PassThrough()
  rawOut.on("data", (c: Buffer) => {
    captured += c.toString()
  })
  const stdout = Object.assign(rawOut, {
    isTTY: true,
    columns,
    rows,
  }) as unknown as NodeJS.WriteStream
  return { stdin, stdout, sink: () => captured }
}

const waitFor = async (read: () => string, needle: string, ms = 5000): Promise<boolean> => {
  const started = Date.now()
  while (Date.now() - started < ms) {
    if (read().includes(needle)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}

const manyMessages = (n: number): TrayambakMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    timestamp: i,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `MSG-${i}`,
  }))

describe("MessageList <Static> identity (frame clones)", () => {
  it("reprints the frame at most once per clock tick, not once per render", async () => {
    const { stdin, stdout, sink } = openStdio()
    // A component that re-renders on a timer with UNCHANGED history — the
    // idle clock's exact shape.
    let force: (n: number) => void = () => {}
    function Harness() {
      const [n, setN] = useState(0)
      force = setN
      void n
      return React.createElement(MessageList, { messages: manyMessages(40) })
    }
    let instance: Instance | undefined
    try {
      instance = render(React.createElement(Harness), { stdin, stdout, patchConsole: false })
      await waitFor(sink, "MSG-39")
      const framesBefore = (sink().match(/MSG-39/g) ?? []).length
      // Re-render with identical history — nothing about the frame changed.
      for (let i = 0; i < 5; i++) {
        force(i + 1)
        await new Promise((r) => setTimeout(r, 30))
      }
      const framesAfter = (sink().match(/MSG-39/g) ?? []).length
      // A no-op re-render must not repaint the transcript rows at all: Ink
      // skips unchanged lines, so the tail text is re-emitted only if the
      // renderer believed the frame itself changed.
      expect(framesAfter - framesBefore).toBeLessThanOrEqual(1)
    } finally {
      instance?.unmount()
    }
  }, 20000)

  it("still appends newly evicted history to the printed prefix", async () => {
    const { stdin, stdout, sink } = openStdio()
    const first = manyMessages(10)
    let setMessages: (m: TrayambakMessage[]) => void = () => {}
    function Harness() {
      const [msgs, setM] = useState<TrayambakMessage[]>(first)
      setMessages = setM
      return React.createElement(MessageList, { messages: msgs })
    }
    let instance: Instance | undefined
    try {
      instance = render(React.createElement(Harness), { stdin, stdout, patchConsole: false })
      await waitFor(sink, "MSG-9")
      // Grow past the frame budget so the oldest rows must move into <Static>.
      setMessages(manyMessages(60))
      const printed = await waitFor(sink, "MSG-0")
      expect(printed).toBe(true)
      // And the live tail is still in the frame, not swallowed by the prefix.
      await waitFor(sink, "MSG-59")
      expect(sink()).toContain("MSG-59")
    } finally {
      instance?.unmount()
    }
  }, 20000)
})