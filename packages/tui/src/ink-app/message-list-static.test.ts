/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { resetGlyphCache } from "./glyphs.js"
import React from "react"
import { PassThrough } from "node:stream"
import { render, type Instance } from "ink"
import { MessageList } from "./MessageList.js"
import type { TrayambakMessage } from "./types.js"

/**
 * Conversation-box contract: the budget-fitting TAIL renders in the frame
 * and the evicted prefix prints above it via <Static> — but ALWAYS
 * BORDERED (│ on both edges, ┌ cap on the first row): scrollback reads as
 * the conversation box continuing upward, never naked lines floating over
 * it (the "box ke bahar" complaint = borderless rows). Geometry note: this
 * file renders MessageList WITHOUT the App root border, so the static
 * rows carry their own │ box while in-frame rows are unbordered here (in
 * the real terminal the App root draws that border for them).
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

/** Split an accumulated ink sink into complete frames. Renders are joined
 *  by 3+ newlines; the trailing chunk may be a mid-write fragment, so it is
 *  dropped whenever at least one full frame exists. Returns per-frame
 *  "Thinking" counts. */
const frameHits = (strippedSink: string): number[] => {
  const chunks = strippedSink
    .split(/\n{3,}/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
  const full = chunks.length > 1 ? chunks.slice(0, -1) : chunks
  return full.map((c) => c.split("Thinking").length - 1)
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

// Glyphs under test render through glyphs.ts, which auto-selects ASCII on
// plain Windows consoles (this CI/dev box) — assertions below pin Unicode
// shapes, so force unicode mode here. resetGlyphCache covers shared workers.
process.env.TRAYAMBAK_GLYPHS = "unicode"
resetGlyphCache()
describe("MessageList history (bordered prefix → scrollback, tail → frame)", () => {
  it("renders the newest rows in-frame and the evicted prefix Bordered above", async () => {
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

      // Newest row renders in the frame…
      expect(await waitFor(sink, "MSG-39")).toBe(true)
      // …the evicted prefix stays REACHABLE above it (never hidden), and
      // every scrollback row sits inside the box's side borders:
      expect(sink()).toContain("MSG-0")
      const line0 = stripAnsi(sink())
        .split(/\r?\n/)
        .find((l) => l.includes("MSG-0"))
      expect(line0?.startsWith("│")).toBe(true)
      expect(line0?.trimEnd().endsWith("│")).toBe(true)
      // No hidden-hint row either — the history is simply there, boxed.
      expect(sink()).not.toContain("older message")
      expect(sink()).not.toContain("hidden —")
    } finally {
      instance?.unmount()
    }
  }, 15000)

  it("a running tool call stays in the dynamic frame (never Static-frozen)", async () => {
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = [
      {
        id: "tool-x1",
        timestamp: 1,
        role: "assistant",
        content: JSON.stringify({ value: "list files" }),
        toolCallId: "x1",
        toolName: "list_dir",
        toolStatus: "running",
      },
    ]

    let instance: Instance | undefined
    try {
      instance = render(React.createElement(MessageList, { messages, isLoading: true }), {
        stdin,
        stdout,
        patchConsole: false,
      })

      // The row must say it's still calling AND carry a real ● — pre-fix
      // ToolUseLoader rendered the boolean `isVisible`, which React drops,
      // leaving an empty 2-col gutter and zero animation. (Unstable rows
      // render live in the frame — they are never frozen by a print-once
      // path.)
      expect(await waitFor(sink, "Calling")).toBe(true)
      expect(sink()).toContain("●")
    } finally {
      instance?.unmount()
    }
  }, 15000)

  it("shows the Thinking spinner on the tail row only (old answers stay still)", async () => {
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = [
      {
        id: "a-old",
        timestamp: 1,
        role: "assistant",
        content: "first answer",
        thinking: "old reasoning",
      },
      {
        id: "a-new",
        timestamp: 2,
        role: "assistant",
        content: "second answer",
        thinking: "new reasoning",
      },
    ]

    let instance: Instance | undefined
    try {
      instance = render(React.createElement(MessageList, { messages, isStreaming: true }), {
        stdin,
        stdout,
        patchConsole: false,
      })
      // Both answers on screen…
      expect(await waitFor(sink, "second answer")).toBe(true)
      expect(sink()).toContain("first answer")
      // …but "Thinking" exactly once: pre-fix every assistant carrying
      // thinking text re-grew a spinner below itself while a later turn
      // streamed (completed answer + stuck ⠙ Thinking… under it).
      const stripped = stripAnsi(sink())
      const hits = stripped.split("Thinking").length - 1
      expect(hits).toBe(1)
    } finally {
      instance?.unmount()
    }
  }, 15000)

  it("never shows two Thinking spinners at once (tail row + bottom line)", async () => {
    // Reported live: isLoading && isStreaming are BOTH true mid-turn, so
    // the tail assistant row rendered "Thinking…" AND the bottom
    // isLoading line rendered a second one. Exactly one, always.
    // NOTE: asserted on the LAST frame only (last 8 sink lines) — the sink
    // accumulates every spinner animation frame, so whole-sink substring
    // counts grow with time instead of measuring concurrent instances.
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = [
      {
        id: "a-live",
        timestamp: 1,
        role: "assistant",
        content: "partial answer",
        thinking: "live reasoning",
      },
    ]

    let instance: Instance | undefined
    try {
      instance = render(React.createElement(MessageList, { messages, isStreaming: true, isLoading: true }), {
        stdin,
        stdout,
        patchConsole: false,
      })
      expect(await waitFor(sink, "partial answer")).toBe(true)
      await wait(200) // a couple of spinner ticks → several frames
      const hits = frameHits(stripAnsi(sink()))
      expect(hits.length).toBeGreaterThan(0)
      // Every complete frame carries exactly one spinner; none carries two.
      expect(hits).toContain(1)
      expect(hits.every((h) => h <= 1)).toBe(true)
    } finally {
      instance?.unmount()
    }
  }, 15000)

  it("keeps the bottom Thinking line for the pre-first-token phase", async () => {
    // Tail assistant with NO thinking yet (turn just started): the row
    // shows nothing, so the bottom line must still carry the spinner —
    // otherwise the turn starts with zero activity indication.
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = [
      { id: "u1", timestamp: 1, role: "user", content: "hi" },
      { id: "a-soon", timestamp: 2, role: "assistant", content: "" },
    ]

    let instance: Instance | undefined
    try {
      instance = render(React.createElement(MessageList, { messages, isStreaming: true, isLoading: true }), {
        stdin,
        stdout,
        patchConsole: false,
      })
      expect(await waitFor(sink, "Thinking")).toBe(true)
      await wait(200)
      const hits = frameHits(stripAnsi(sink()))
      expect(hits.length).toBeGreaterThan(0)
      expect(hits).toContain(1)
      expect(hits.every((h) => h <= 1)).toBe(true)
    } finally {
      instance?.unmount()
    }
  }, 15000)

  it("a completed tool call carries the status mark (✓ / ✗ per ported palette)", async () => {
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = [
      {
        id: "tool-ok",
        timestamp: 1,
        role: "assistant",
        content: JSON.stringify({ value: "list files" }),
        toolCallId: "ok1",
        toolName: "list_dir",
        toolStatus: "completed",
        result: "a.ts\nb.ts",
      },
      {
        id: "tool-err",
        timestamp: 2,
        role: "assistant",
        content: JSON.stringify({ value: "bad call" }),
        toolCallId: "err1",
        toolName: "bash",
        toolStatus: "error",
        isError: true,
        result: "boom",
      },
    ]

    let instance: Instance | undefined
    try {
      instance = render(React.createElement(MessageList, { messages }), {
        stdin,
        stdout,
        patchConsole: false,
      })
      // Ported tool-palette resultLine: finished rows end with ✓ green
      // bold / ✗ red bold before the dim duration — "add colour" pass.
      expect(await waitFor(sink, "✓")).toBe(true)
      expect(sink()).toContain("✗")
      expect(sink()).toContain("Called")
    } finally {
      instance?.unmount()
    }
  }, 15000)

  it("an oversized answer: END in-frame, head printed BORDERED to scrollback", async () => {
    // Reported live: the newest response taller than the frame lost its
    // BOTTOM rows to the overflow clip — read downward and it vanished
    // under the input box ("input box ke niche assistant ka half response
    // hidden"). rows=30 → rowBudget=23; this body is ~81 rows.
    const { stdin, stdout, sink } = openStdio(80)
    const lines = Array.from({ length: 80 }, (_, i) => `line-${i}`)
    lines[79] = "END-MARKER-LAST"
    const messages: TrayambakMessage[] = [
      { id: "u1", timestamp: 1, role: "user", content: "list" },
      { id: "big-answer", timestamp: 2, role: "assistant", content: lines.join("\n") },
    ]

    let instance: Instance | undefined
    try {
      instance = render(React.createElement(MessageList, { messages }), {
        stdin,
        stdout,
        patchConsole: false,
      })
      // 1. The response's END renders (bottom-anchored tail) — pre-fix the
      //    frame showed only the first ~21 rows and this never appeared.
      expect(await waitFor(sink, "END-MARKER-LAST")).toBe(true)
      // 2. The head printed ONCE, BORDERED (wheel-up reads one continuous
      //    boxed answer — reachable history, never a naked line above the
      //    frame). Give any stray flush a beat to land first.
      await wait(200)
      expect(stripAnsi(sink())).toContain("line-0")
      const headLine = stripAnsi(sink())
        .split(/\r?\n/)
        .find((l) => l.includes("line-0"))
      expect(headLine?.startsWith("│")).toBe(true)
      expect(headLine?.trimEnd().endsWith("│")).toBe(true)
      // 3. NO hint/marker row ever (user: "DONT SHOW THIS") — nothing
      //    interrupts the transcript.
      expect(stripAnsi(sink())).not.toContain("earlier lines")
      // 4. Nothing is announced as hidden behind a count hint either.
      expect(sink()).not.toContain("older message")
      expect(sink()).not.toContain("hidden —")
    } finally {
      instance?.unmount()
    }
  }, 15000)

  it("reports its scrollback prefix to App (which hides the frame divider)", async () => {
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`,
      timestamp: i,
      role: "user",
      content: `MSG-${i}`,
    }))

    let reported: boolean | undefined
    let instance: Instance | undefined
    try {
      instance = render(
        React.createElement(MessageList, {
          messages,
          onHasPrefix: (has: boolean) => {
            reported = has
          },
        }),
        { stdin, stdout, patchConsole: false },
      )
      // The prefix evicts immediately (40 msgs ≫ the row budget) → the
      // callback reports true → App renders the root WITHOUT its top
      // border, so no ┌────┐ divider ever lands mid-conversation.
      expect(await waitFor(sink, "MSG-39")).toBe(true)
      await wait(150)
      expect(reported).toBe(true)
    } finally {
      instance?.unmount()
    }
  }, 15000)

  it("reports NO prefix for a fresh short conversation (┌ cap stays)", async () => {
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = [
      { id: "u1", timestamp: 1, role: "user", content: "hi" },
      { id: "a1", timestamp: 2, role: "assistant", content: "hello" },
    ]

    let reported: boolean | undefined
    let instance: Instance | undefined
    try {
      instance = render(
        React.createElement(MessageList, {
          messages,
          onHasPrefix: (has: boolean) => {
            reported = has
          },
        }),
        { stdin, stdout, patchConsole: false },
      )
      expect(await waitFor(sink, "hello")).toBe(true)
      await wait(150)
      // Nothing printed above → the frame keeps its ┌ opening row.
      expect(reported).toBe(false)
    } finally {
      instance?.unmount()
    }
  }, 15000)
})

describe("MessageList tool boxes stretch to the window width", () => {
  // Regression: the row wrappers defaulted to flex ROWs, so MessageRow was
  // sized to CONTENT and the tool box hugged its ~45-col header instead of
  // filling the terminal ("ek parallel line — jitni window width utna
  // stretched"). wrappers are columns now → MessageRow cross-stretches →
  // width="100%" resolves against the full width. Asserted on BOTH halves
  // (in-frame rows and the bordered <Static> prefix above) — same columns
  // in each path, so a hug can't hide in either.
  it("spans ~full width in the frame (100 cols)", async () => {
    const { stdin, stdout, sink } = openStdio(100)
    const messages: TrayambakMessage[] = []
    // Enough history that the row budget caps the window: the oldest
    // completed tools print Bordered above (prefix); the newest completed
    // + the running one stay in-frame.
    for (let i = 0; i < 20; i += 1) {
      messages.push({
        id: `t${i}`,
        timestamp: i,
        role: "assistant",
        content: JSON.stringify({ value: `job ${i}` }),
        toolCallId: `c${i}`,
        toolName: "list_dir",
        toolStatus: "completed",
        result: "ok",
      })
    }
    messages.push({
      id: "t-run",
      timestamp: 99,
      role: "assistant",
      content: JSON.stringify({ value: "live job" }),
      toolCallId: "run-live",
      toolName: "list_dir",
      toolStatus: "running",
    })

    let instance: Instance | undefined
    try {
      instance = render(React.createElement(MessageList, { messages, isLoading: true }), {
        stdin,
        stdout,
        patchConsole: false,
      })
      // Finished + live rows in-frame: "Called" (finished) + "Calling" (live).
      expect(await waitFor(sink, "Called")).toBe(true)
      expect(await waitFor(sink, "Calling")).toBe(true)

      const lines = sink().split(/\r?\n/).map(stripAnsi)
      // All boxes are round now (╭╮) — the conversation frame, the tool
      // boxes inside it, even the footer section share the same corners.
      const borders = lines.filter((l) => l.includes("╭") && l.includes("╮"))
      // At least the finished + live frame boxes; padding must not mask a hug.
      expect(borders.length).toBeGreaterThanOrEqual(2)
      for (const line of borders) {
        const start = line.indexOf("╭")
        const end = line.indexOf("╮")
        // Box starts near the left edge …
        expect(start).toBeLessThanOrEqual(4)
        // … and its right edge sits within a few cols of the window's end
        // (the old content-hug measured ~45-55 here).
        expect(end - start + 1).toBeGreaterThanOrEqual(100 - 6)
      }
    } finally {
      instance?.unmount()
    }
  }, 15000)
})
