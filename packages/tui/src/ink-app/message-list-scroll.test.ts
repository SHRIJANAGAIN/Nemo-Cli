/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import React from "react"
import { PassThrough } from "node:stream"
import { render, type Instance } from "ink"
import { MessageList } from "./MessageList.js"
import type { TrayambakMessage } from "./types.js"

/**
 * Lifetime wheel scroll + the generation animation.
 *
 * Contract: App enables SGR mouse reporting for the TUI's lifetime, and the
 * wheel bus slides MessageList's window back by `scrollBack` messages —
 * the frame then shows OLDER conversation ("AI generates kar raha hai aur
 * scroll ek jagah pe dubara aa jata hai" — native scroll was yanked by
 * every token write; this window can't be yanked). The print-once prefix
 * keeps following the LIVE split: scrolling never re-cuts what Ink wrote.
 *
 * Phase-aware bottom line: phase "running" (text streaming) → "Generating…"
 * with cycling colors; anything else → the old "Thinking…". The tail row's
 * reasoning spinner stands down while tokens flow (reasoning is done), and
 * a SCROLLED window's old tail never inherits any live spinner.
 */

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

/** Poll the frame sink until `needle` shows up (frames arrive async). */
async function waitFor(sink: () => string, needle: string, ms = 4000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (sink().includes(needle)) return true
    await wait(25)
  }
  return false
}

const openStdio = (columns = 80): { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream; sink: () => string } => {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => {},
    ref: () => {},
    unref: () => {},
  }) as unknown as NodeJS.ReadStream
  const rawOut = new PassThrough()
  let captured = ""
  rawOut.on("data", (chunk: Buffer) => {
    captured += chunk.toString()
  })
  const stdout = Object.assign(rawOut, {
    isTTY: true,
    columns,
    rows: 30,
  }) as unknown as NodeJS.WriteStream
  return { stdin, stdout, sink: () => captured }
}

describe("MessageList wheel scroll (scrolled window vs live tail)", () => {
  it("scrollBack slides the window back: older tail in-frame, newest OFF-screen, frame all history", async () => {
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`,
      timestamp: i,
      role: "user",
      content: `MSG-${i}`,
    }))

    let instance: Instance | undefined
    try {
      instance = render(React.createElement(MessageList, { messages, scrollBack: 5 }), {
        stdin,
        stdout,
        patchConsole: false,
      })

      // The window's last row is 5 messages before the live end…
      expect(await waitFor(sink, "MSG-34")).toBe(true)
      // No ↑ history marker row: it stole a budget row from history and
      // said nothing the window itself doesn't prove ("no need see ye —
      // pura show hota rahe"):
      expect(stripAnsi(sink())).not.toContain("↑ history")
      // …and the live newest rows are in NEITHER the frame (window slid
      // back) NOR the printed prefix (that's the LIVE split's eviction,
      // which stops at the current window start) — they simply aren't
      // shown until the user returns to live:
      expect(sink()).not.toContain("MSG-39")
      expect(sink()).not.toContain("MSG-35")
      // The prefix still printed above (wheel-up reads it, bordered — the
      // scrollback contract this file must not disturb):
      expect(sink()).toContain("MSG-0")
    } finally {
      instance?.unmount()
    }
  }, 15000)

  it("scrollBack=0 is byte-identical live behavior: newest shown, NO hint row", async () => {
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`,
      timestamp: i,
      role: "user",
      content: `MSG-${i}`,
    }))

    let instance: Instance | undefined
    try {
      instance = render(React.createElement(MessageList, { messages }), {
        stdin,
        stdout,
        patchConsole: false,
      })
      expect(await waitFor(sink, "MSG-39")).toBe(true)
      expect(sink()).not.toContain("scrolled back")
      expect(sink()).toContain("MSG-0")
    } finally {
      instance?.unmount()
    }
  }, 15000)

  it("a scrolled window's old tail never inherits the live Thinking spinner", async () => {
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = Array.from({ length: 40 }, (_, i) =>
      i === 34
        ? {
            id: `m${i}`,
            timestamp: i,
            role: "assistant" as const,
            content: `ANS-${i}`,
            thinking: `old-reason-${i}`,
          }
        : { id: `m${i}`, timestamp: i, role: "user" as const, content: `MSG-${i}` },
    )

    let instance: Instance | undefined
    try {
      instance = render(
        React.createElement(MessageList, {
          messages,
          scrollBack: 5,
          isLoading: true,
          isStreaming: true,
        }),
        { stdin, stdout, patchConsole: false },
      )

      // The scrolled tail (the OLD answer at index 34) renders its content…
      expect(await waitFor(sink, "ANS-34")).toBe(true)
      // …and rows past the printed prefix prove the FRAME slid back (MSG-33
      // is neither in the live split's prefix [0..29) nor beyond the
      // window): the window itself, not just scrollback, shows the old tail.
      expect(sink()).toContain("MSG-33")
      // …with NO "Thinking" anywhere: the tail gate is liveTail-scoped, so
      // an old completed answer can't grow a spinner under itself just
      // because a later turn is streaming (the regression the live-tail
      // gate always prevented — now also enforced off-live).
      expect(stripAnsi(sink()).split("Thinking").length - 1).toBe(0)
      // And no bottom line either: the turn's spinner belongs over the LIVE
      // tail only (the footer keeps pulsing to show generation continues).
      expect(sink()).not.toContain("Generating")
      // NO marker row steals a budget row while scrolled — history fills
      // the frame edge to edge:
      expect(sink()).not.toContain("↑ history")
    } finally {
      instance?.unmount()
    }
  }, 15000)
})

describe("MessageList generation animation (phase-aware bottom line)", () => {
  it("phase 'running' → 'Generating…' animates, and NO stale 'Thinking…' anywhere", async () => {
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = [
      { id: "q", timestamp: 1, role: "user", content: "question" },
      { id: "a", timestamp: 2, role: "assistant", content: "partial answer", thinking: "reasoning done" },
    ]

    let instance: Instance | undefined
    try {
      instance = render(
        React.createElement(MessageList, {
          messages,
          isLoading: true,
          isStreaming: true,
          phase: "running",
        }),
        { stdin, stdout, patchConsole: false },
      )
      expect(await waitFor(sink, "Generating…")).toBe(true)
      // Reasoning is over while tokens flow: neither the tail row nor the
      // bottom line may claim "Thinking…" (the old code spun it through
      // the whole answer). Asserted across the WHOLE sink — the label must
      // never appear in any frame, not just the latest.
      expect(stripAnsi(sink()).split("Thinking").length - 1).toBe(0)
      expect(sink()).toContain("partial answer")
    } finally {
      instance?.unmount()
    }
  }, 15000)

  it("phase 'thinking' keeps the old 'Generating'-free 'Thinking…' line", async () => {
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = [
      { id: "q", timestamp: 1, role: "user", content: "question" },
      { id: "a", timestamp: 2, role: "assistant", content: "partial answer" },
    ]

    let instance: Instance | undefined
    try {
      instance = render(
        React.createElement(MessageList, {
          messages,
          isLoading: true,
          isStreaming: true,
          phase: "thinking",
        }),
        { stdin, stdout, patchConsole: false },
      )
      expect(await waitFor(sink, "Thinking…")).toBe(true)
      expect(sink()).not.toContain("Generating")
    } finally {
      instance?.unmount()
    }
  }, 15000)
})

describe("TTL-hidden notices in the live frame", () => {
  it("drops the flagged row from the frame while its neighbours still render", async () => {
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = [
      { id: "m0", timestamp: 1, role: "user", content: "VISIBLE-BEFORE" },
      { id: "m1", timestamp: 2, role: "system", content: "MODE-NOTICE-TEXT", transientHidden: true },
      { id: "m2", timestamp: 3, role: "assistant", content: "VISIBLE-AFTER" },
    ]

    let instance: Instance | undefined
    try {
      instance = render(React.createElement(MessageList, { messages }), {
        stdin,
        stdout,
        patchConsole: false,
      })
      expect(await waitFor(sink, "VISIBLE-AFTER")).toBe(true)
      // The flagged row renders as NOTHING in the frame; its neighbours
      // (same window, same frame) render exactly as before:
      expect(sink()).toContain("VISIBLE-BEFORE")
      expect(sink()).not.toContain("MODE-NOTICE-TEXT")
    } finally {
      instance?.unmount()
    }
  }, 15000)
})
