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
 * The live window + the generation animation.
 *
 * Contract: the frame always shows the NEWEST messages that fit the row
 * budget — the in-app wheel-park window was removed entirely ("up down
 * totally hata do, only auto scroll"): no scrollBack offset exists, so no
 * scroll can hide the response, and during generation the same rule holds
 * (tokens append to the live tail and the terminal follows — that IS the
 * auto-scroll). History reads through the terminal's NATIVE scroll over
 * the print-once <Static> prefix (mouse reporting stays OFF app-wide).
 * The print-once frontier follows the LIVE split only — nothing ever
 * re-cuts what Ink already wrote ("old must be same").
 *
 * Phase-aware bottom line: phase "running" (text streaming) → "Generating…"
 * with cycling colors; anything else → the old "Thinking…". The tail row's
 * reasoning spinner stands down while tokens flow (reasoning is done).
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

/** Poll a synchronous predicate (effect-fired callbacks, not frame text). */
async function waitForFn(fn: () => boolean, ms = 4000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (fn()) return true
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

describe("MessageList live window (newest always in-frame, print-once prefix)", () => {
  it("shows the newest message in-frame and the old prefix above, NO hint row", async () => {
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
      // The newest is always in the frame — auto-scroll only: no offset
      // exists that could park the window off the response.
      expect(await waitFor(sink, "MSG-39")).toBe(true)
      // No hint row steals a budget row from history ("pura show hota
      // rahe") — and no "scrolled back" marker state exists at all:
      expect(stripAnsi(sink())).not.toContain("↑ history")
      expect(sink()).not.toContain("● live")
      expect(sink()).not.toContain("new below")
      // The evicted prefix printed ONCE above the frame, for the terminal's
      // native scroll to read (the scrollback contract):
      expect(sink()).toContain("MSG-0")
    } finally {
      instance?.unmount()
    }
  }, 15000)

  it("mid-generation the SAME live rule holds: newest visible + Generating… (auto-scroll)", async () => {
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = Array.from({ length: 40 }, (_, i) =>
      i === 39
        ? { id: `m${i}`, timestamp: i, role: "assistant" as const, content: "LIVE-STREAMING-ANSWER" }
        : { id: `m${i}`, timestamp: i, role: "user" as const, content: `MSG-${i}` },
    )

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
      // The streaming answer is in-frame with its live status line — no
      // wheel window exists that could hide it before or during a turn:
      // generation auto-scrolls the same way everything else does.
      expect(await waitFor(sink, "LIVE-STREAMING-ANSWER")).toBe(true)
      expect(sink()).toContain("Generating…")
      expect(sink()).not.toContain("↑ history")
      expect(sink()).not.toContain("● live")
      expect(sink()).not.toContain("new below")
    } finally {
      instance?.unmount()
    }
  }, 15000)

  it("reports the window start index to onScrollDepth (the ↑N depth chip)", async () => {
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`,
      timestamp: i,
      role: "user",
      content: `MSG-${i}`,
    }))
    const depths: number[] = []

    let instance: Instance | undefined
    try {
      instance = render(
        React.createElement(MessageList, { messages, onScrollDepth: (d: number) => depths.push(d) }),
        { stdin, stdout, patchConsole: false },
      )
      expect(await waitFor(sink, "MSG-39")).toBe(true)
      // Older rows evicted above the frame → the chip reports their count
      // (pure info; the frame itself never moves):
      expect(await waitForFn(() => depths.length > 0 && depths[depths.length - 1]! > 0)).toBe(true)
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

  it("status line carries elapsed seconds while loading (slow model never reads as dead)", async () => {
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = [
      { id: "q", timestamp: 1, role: "user", content: "ELAPSED-Q" },
      { id: "a", timestamp: 2, role: "assistant", content: "ELAPSED-A" },
    ]

    let instance: Instance | undefined
    try {
      instance = render(
        React.createElement(MessageList, {
          messages,
          isLoading: true,
          isStreaming: true,
          phase: "thinking",
          turnStartedAt: Date.now(),
        }),
        { stdin, stdout, patchConsole: false },
      )
      expect(await waitFor(sink, "ELAPSED-A")).toBe(true)
      // "Thinking… Ns" — the seconds prove the turn is alive, not stuck:
      expect(stripAnsi(sink())).toMatch(/Thinking… \d+s/)
    } finally {
      instance?.unmount()
    }
  }, 15000)

  it("status line shows no seconds without a turn start (old renders unchanged)", async () => {
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = [{ id: "q", timestamp: 1, role: "user", content: "PLAIN-Q" }]

    let instance: Instance | undefined
    try {
      instance = render(
        React.createElement(MessageList, { messages, isLoading: true, phase: "thinking" }),
        { stdin, stdout, patchConsole: false },
      )
      expect(await waitFor(sink, "Thinking…")).toBe(true)
      expect(stripAnsi(sink())).not.toMatch(/\d+s/)
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

describe("live windows (no strip — there is no parked state to flicker)", () => {
  const shortMessages = (): TrayambakMessage[] => [
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      timestamp: i,
      role: "user" as const,
      content: `HISTORY-${i}`,
    })),
    { id: "live", timestamp: 9, role: "assistant" as const, content: "LIVE-TAIL-XYZ" },
  ]

  it("a live window shows no strip (byte-identical old behavior)", async () => {
    const { stdin, stdout, sink } = openStdio()
    let instance: Instance | undefined
    try {
      instance = render(React.createElement(MessageList, { messages: shortMessages() }), {
        stdin,
        stdout,
        patchConsole: false,
      })
      expect(await waitFor(sink, "LIVE-TAIL-XYZ")).toBe(true)
      expect(sink()).not.toContain("● live")
    } finally {
      instance?.unmount()
    }
  }, 15000)

  it("a faded (transientHidden) last row pins no strip", async () => {
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = [
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        timestamp: i,
        role: "user" as const,
        content: `HISTORY-${i}`,
      })),
      { id: "gone", timestamp: 9, role: "system" as const, content: "FADED-NOTICE", transientHidden: true },
    ]
    let instance: Instance | undefined
    try {
      instance = render(React.createElement(MessageList, { messages }), {
        stdin,
        stdout,
        patchConsole: false,
      })
      expect(await waitFor(sink, "HISTORY-0")).toBe(true)
      expect(sink()).not.toContain("● live")
      expect(sink()).not.toContain("FADED-NOTICE")
    } finally {
      instance?.unmount()
    }
  }, 15000)
})

describe("MessageList has no custom gutter (Windows inbuilt owns the edge)", () => {
  it("renders no thumb cells even when the transcript overflows", async () => {
    // The in-app bar is gone by decision (it read as a smear next to the
    // Windows bar in the same gray). Only the thumb glyph █ is unique to
    // it — borders use │/─/corners everywhere, so its absence is exact:
    // overflow content still renders, with zero drawn bar.
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`,
      timestamp: i,
      role: "user" as const,
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
      expect(stripAnsi(sink())).not.toContain("█")
      expect(sink()).toContain("MSG-0")
    } finally {
      instance?.unmount()
    }
  }, 15000)
})

describe("MessageList live frame (no pill line)", () => {
  it("an oversized paste prints head + tail exactly once each (no user-duplicate)", async () => {
    const { stdin, stdout, sink } = openStdio()
    // 30 unique lines ≈ 31 rows > the 22-row budget (rows 30 − chrome 7 −
    // 1 Windows-ink slack):
    // the completed blob splits once — head to scrollback, tail in-frame.
    // Either half printed twice would read as the user's "USER KA DUPLICATE".
    const lines = Array.from({ length: 30 }, (_, i) => `BLOB-LINE-${String(i).padStart(2, "0")}`)
    const messages: TrayambakMessage[] = [{ id: "blob", timestamp: 1, role: "user", content: lines.join("\n") }]
    let instance: Instance | undefined
    try {
      instance = render(React.createElement(MessageList, { messages }), {
        stdin,
        stdout,
        patchConsole: false,
      })
      expect(await waitFor(sink, "BLOB-LINE-00")).toBe(true)
      expect(await waitFor(sink, "BLOB-LINE-29")).toBe(true)
      const frame = stripAnsi(sink())
      for (const marker of ["BLOB-LINE-00", "BLOB-LINE-14", "BLOB-LINE-29"]) {
        expect(frame.split(marker).length - 1).toBe(1)
      }
    } finally {
      instance?.unmount()
    }
  }, 15000)

  it("a live window shows no pill (byte-identical old behavior)", async () => {
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = [
      { id: "q", timestamp: 1, role: "user", content: "PILL-LIVE-Q" },
      { id: "a", timestamp: 2, role: "assistant", content: "PILL-LIVE-A" },
    ]
    let instance: Instance | undefined
    try {
      instance = render(React.createElement(MessageList, { messages }), {
        stdin,
        stdout,
        patchConsole: false,
      })
      expect(await waitFor(sink, "PILL-LIVE-A")).toBe(true)
      expect(sink()).not.toContain("new below")
    } finally {
      instance?.unmount()
    }
  }, 15000)
})
