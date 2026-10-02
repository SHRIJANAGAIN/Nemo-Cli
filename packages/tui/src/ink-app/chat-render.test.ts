/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import React from "react"
import { PassThrough } from "node:stream"
import { render, type Instance } from "ink"
import { PromptInput } from "./PromptInput.js"
import { MessageList } from "./MessageList.js"
import { shouldShowSidebar, SIDEBAR_MIN_COLS } from "./Sidebar.js"
import type { TrayambakMessage } from "./types.js"

/**
 * Composer + transcript render guards (reported live with screenshots):
 *
 *  1. The composer placeholder must be Trayambak's own — a stale
 *     "Ask Codex to do anything" shipped in an old build and must never
 *     come back.
 *  2. Chooser arrows must move the highlight: Down then Enter picks a
 *     DIFFERENT command than bare Enter (the "chat upar-niche nahi hoti"
 *     report was the highlight never visibly moving).
 *  3. Transcript rows carry no background colour — answers must not render
 *     as dark blocks.
 *  4. The fixed 42-col sidebar stands down on narrow terminals instead of
 *     squeezing the chat into wrapped slivers.
 */

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

async function waitFor(sink: () => string, needle: string, ms = 5000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (sink().includes(needle)) return true
    await wait(25)
  }
  return false
}

async function waitForFn(cond: () => boolean, ms = 5000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (cond()) return true
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

const noop = (): void => {}

function renderComposer(draft: string | null): {
  instance: Instance
  sink: () => string
  stdin: NodeJS.ReadStream
  picked: Array<{ cmd: string; args: string }>
} {
  const { stdin, stdout, sink } = openStdio()
  const picked: Array<{ cmd: string; args: string }> = []
  const instance = render(
    React.createElement(PromptInput, {
      onSubmit: noop,
      onSlashCommand: (cmd: string, args: string) => {
        picked.push({ cmd, args })
      },
      onChoose: noop,
      draftRequest: draft === null ? null : { text: draft, nonce: 1 },
    }),
    { stdin, stdout, patchConsole: false },
  )
  return { instance, sink, stdin, picked }
}

describe("composer placeholder", () => {
  it("invites with Trayambak's own ask line — never a rival brand", async () => {
    const { instance, sink } = renderComposer(null)
    try {
      expect(await waitFor(sink, "Ask Trayambak to do anything...")).toBe(true)
      expect(sink()).not.toContain("Codex")
    } finally {
      instance.unmount()
    }
  })
})

describe("chooser arrow navigation", () => {
  it("Down then Enter picks a different command than bare Enter", async () => {
    // Baseline: Enter on the fresh menu picks the top hit.
    const first = renderComposer("/m")
    let cmdA = ""
    try {
      expect(await waitFor(first.sink, "/model")).toBe(true)
      first.stdin.write("\r")
      expect(await waitForFn(() => first.picked.length > 0)).toBe(true)
      cmdA = first.picked[0]?.cmd ?? ""
      expect(cmdA.length).toBeGreaterThan(0)
    } finally {
      first.instance.unmount()
    }

    // Down arrow moves the highlight: Enter must now pick its neighbour.
    const second = renderComposer("/m")
    try {
      expect(await waitFor(second.sink, "/model")).toBe(true)
      second.stdin.write("\x1b[B")
      await wait(300)
      second.stdin.write("\r")
      expect(await waitForFn(() => second.picked.length > 0)).toBe(true)
      const cmdB = second.picked[0]?.cmd ?? ""
      expect(cmdB.length).toBeGreaterThan(0)
      expect(cmdB).not.toBe(cmdA)
    } finally {
      second.instance.unmount()
    }
  }, 20000)
})

describe("transcript has no background colour", () => {
  it("user/assistant/tool rows render with foreground styling only", async () => {
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = [
      { id: "u1", timestamp: 1, role: "user", content: "hello agent" },
      { id: "a1", timestamp: 2, role: "assistant", content: "hello human, here is your answer" },
      {
        id: "t1",
        timestamp: 3,
        role: "assistant",
        content: '{"command":"ls"}',
        toolCallId: "call_1",
        toolName: "bash",
        result: "file.txt",
        isError: false,
      },
    ]
    let instance: Instance | undefined
    try {
      instance = render(React.createElement(MessageList, { messages }), {
        stdin,
        stdout,
        patchConsole: false,
      })
      expect(await waitFor(sink, "hello human")).toBe(true)
      // Background SGRs: 48;5/48;2 (256/truecolor) and 40-47/100-107.
      // Foreground colours (30-37/90-97/38;5) are the only paint allowed.
      expect(sink()).not.toMatch(/\x1b\[48;5|\x1b\[48;2|\x1b\[(4[0-7]|10[0-7])m/)
      expect(stripAnsi(sink())).toContain("hello agent")
    } finally {
      instance?.unmount()
    }
  }, 15000)
})

describe("sidebar width guard", () => {
  it("stands down below the minimum instead of squeezing the chat", () => {
    expect(SIDEBAR_MIN_COLS).toBeGreaterThan(42)
    expect(shouldShowSidebar(true, 120)).toBe(true)
    expect(shouldShowSidebar(true, SIDEBAR_MIN_COLS)).toBe(true)
    expect(shouldShowSidebar(true, 40)).toBe(false)
    expect(shouldShowSidebar(true, undefined)).toBe(false)
    expect(shouldShowSidebar(false, 200)).toBe(false)
  })
})
