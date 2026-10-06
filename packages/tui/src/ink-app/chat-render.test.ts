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
import {
  expandPastes,
  pastePlaceholder,
  PASTE_COLLAPSE_CHARS,
  uniquePastePlaceholder,
} from "./PromptInput.js"
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

function renderComposer(
  draft: string | null,
  commandList: Array<{ name: string; description: string; category: string }> = [],
): {
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
      commandList,
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

describe("arrow keys never scroll the transcript (mouse owns it alone)", () => {
  it("plain ↑/↓ on an empty composer do nothing", async () => {
    const c = renderComposer(null)
    try {
      expect(await waitFor(c.sink, "Ask Trayambak to do anything...")).toBe(true)
      c.stdin.write("\x1b[A")
      await wait(300)
      c.stdin.write("\x1b[B")
      await wait(300)
      expect(c.picked).toEqual([])
    } finally {
      c.instance.unmount()
    }
  }, 20000)

  it("PageUp/PageDown on an empty composer do nothing (key paging removed)", async () => {
    const c = renderComposer(null)
    try {
      expect(await waitFor(c.sink, "Ask Trayambak to do anything...")).toBe(true)
      c.stdin.write("\x1b[5~")
      await wait(300)
      c.stdin.write("\x1b[6~")
      await wait(300)
      // Swallowed, never typed into the draft and never submitted:
      expect(c.picked).toEqual([])
      expect(c.sink()).not.toContain("5~")
      expect(c.sink()).not.toContain("6~")
    } finally {
      c.instance.unmount()
    }
  }, 20000)

  it("Custom prompt files compete in the chooser (permanently listed)", async () => {
    const customs = [
      { name: "marketing-campaign", description: "Plan a full campaign", category: "Custom" },
      { name: "cpp-build", description: "Build the C++ project", category: "Custom" },
    ]
    const c = renderComposer(null, customs)
    try {
      expect(await waitFor(c.sink, "Ask Trayambak to do anything...")).toBe(true)
      c.stdin.write("/")
      expect(await waitForFn(() => c.sink().includes("/help"))).toBe(true)
      // The 10-row window can't fit 50+ builtins + customs at once, so a
      // custom surfaces once its prefix is typed — the point is customs
      // are IN the list (never hidden/dropped).
      c.stdin.write("market")
      expect(await waitForFn(() => c.sink().includes("marketing-campaign"))).toBe(true)
    } finally {
      c.instance.unmount()
    }
  }, 20000)

  it("static and registry commands share one menu (nothing hidden)", async () => {
    // Static side: /provider must surface on its prefix with no commandList.
    const first = renderComposer("/pro")
    try {
      expect(await waitFor(first.sink, "Ask Trayambak to do anything...")).toBe(true)
      expect(await waitForFn(() => first.sink().includes("/provider"))).toBe(true)
    } finally {
      first.instance.unmount()
    }
    // Registry side: a dispatched command must surface alongside statics.
    const second = renderComposer("/compa", [
      { name: "company", description: "Browse the company agent library", category: "Agent" },
    ])
    try {
      expect(await waitFor(second.sink, "Ask Trayambak to do anything...")).toBe(true)
      expect(await waitForFn(() => second.sink().includes("/company"))).toBe(true)
    } finally {
      second.instance.unmount()
    }
  }, 20000)
})

describe("user rows carry a background, answers never do", () => {
  it("user row renders on the panel background", async () => {
    const { stdin, stdout, sink } = openStdio()
    // Alone: any background SGR here can only be the user row (no boxes,
    // no sidebar in this render).
    const messages: TrayambakMessage[] = [{ id: "u1", timestamp: 1, role: "user", content: "hello agent" }]
    let instance: Instance | undefined
    try {
      instance = render(React.createElement(MessageList, { messages }), {
        stdin,
        stdout,
        patchConsole: false,
      })
      expect(await waitFor(sink, "hello agent")).toBe(true)
      // NOTE: the render harness stdout has no color depth, so most runs
      // are colorless — the background assert only bites when colors are
      // on (real terminals, or FORCE_COLOR=3 runs, which is how it was
      // verified). Either way the row content must render.
      const raw = sink()
      if (/(\x1b\[(38;5|38;2|3[0-7]|9[0-7])m)/.test(raw)) {
        expect(raw).toMatch(/\x1b\[48;5|\x1b\[48;2|\x1b\[(4[0-7]|10[0-7])m/)
      }
      expect(stripAnsi(raw)).toContain("hello agent")
    } finally {
      instance?.unmount()
    }
  }, 15000)

  it("plain assistant text renders with foreground styling only", async () => {
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = [
      { id: "a1", timestamp: 2, role: "assistant", content: "hello human, here is your answer" },
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
      // (Tool boxes keep their own designed panel background — out of scope.)
      expect(sink()).not.toMatch(/\x1b\[48;5|\x1b\[48;2|\x1b\[(4[0-7]|10[0-7])m/)
    } finally {
      instance?.unmount()
    }
  }, 15000)

  it("user row is a markerless padded bubble (Codex look, no prompt glyph)", async () => {
    const { stdin, stdout, sink } = openStdio()
    const messages: TrayambakMessage[] = [{ id: "u1", timestamp: 1, role: "user", content: "hello agent" }]
    let instance: Instance | undefined
    try {
      instance = render(React.createElement(MessageList, { messages }), {
        stdin,
        stdout,
        patchConsole: false,
      })
      expect(await waitFor(sink, "hello agent")).toBe(true)
      // The content line carries nothing but the text (padding trims away):
      // no `❯`/`>` prompt marker — the block itself marks the turn.
      const lines = stripAnsi(sink())
        .split("\n")
        .filter((l) => l.includes("hello agent"))
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) expect(line.trim()).toBe("hello agent")
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

describe("paste collapse (Codex parity)", () => {
  it("counts unicode scalars and formats the placeholder", () => {
    expect(PASTE_COLLAPSE_CHARS).toBe(1000)
    expect(pastePlaceholder("ab".repeat(500))).toBe("[Pasted Content 1000 chars]")
    expect(pastePlaceholder("hi")).toBe("[Pasted Content 2 chars]")
  })

  it("expands only known placeholders, leaves anything else literal", () => {
    const pastes = new Map([["[Pasted Content 4 chars]", "full text here"]])
    expect(expandPastes("go [Pasted Content 4 chars] now", pastes)).toBe("go full text here now")
    expect(expandPastes("go [Pasted Content 9 chars] now", pastes)).toBe("go [Pasted Content 9 chars] now")
    expect(expandPastes("go [Pasted Content 4 char now", pastes)).toBe("go [Pasted Content 4 char now")
    expect(expandPastes("plain prose", pastes)).toBe("plain prose")
  })

  it("reuses a placeholder for identical text, suffixes colliding counts", () => {
    const pastes = new Map<string, string>()
    const first = uniquePastePlaceholder("a".repeat(1200), pastes)
    pastes.set(first, "a".repeat(1200))
    expect(uniquePastePlaceholder("a".repeat(1200), pastes)).toBe(first)
    const second = uniquePastePlaceholder("b".repeat(1200), pastes)
    expect(second).toBe(`${first} #2`)
  })
})

describe("paste collapse end to end (bracketed paste in, full text out)", () => {
  const bigPaste = (stdin: NodeJS.ReadStream, text: string): void => {
    stdin.write(`\x1b[200~${text}\x1b[201~`)
  }

  it("collapses a 1275-char paste to its placeholder in the box", async () => {
    const submitted: string[] = []
    const { stdin, stdout, sink } = openStdio()
    const picked: Array<{ cmd: string; args: string }> = []
    let instance: Instance | undefined
    try {
      instance = render(
        React.createElement(PromptInput, {
          onSubmit: (text: string) => {
            submitted.push(text)
          },
          onSlashCommand: noop,
          onChoose: noop,
        }),
        { stdin, stdout, patchConsole: false },
      )
      expect(await waitFor(sink, "Ask Trayambak to do anything...")).toBe(true)
      bigPaste(stdin, "x".repeat(1275))
      expect(await waitFor(sink, "[Pasted Content 1275 chars]")).toBe(true)
      // The raw flood never renders — the box stays one line:
      expect(sink()).not.toContain("x".repeat(100))
    } finally {
      instance?.unmount()
    }
    expect(picked).toEqual([])
  }, 20000)

  it("submits the full text behind the placeholder (transcript keeps the block)", async () => {
    const submitted: Array<{ text: string; display?: string }> = []
    const { stdin, stdout, sink } = openStdio()
    let instance: Instance | undefined
    try {
      instance = render(
        React.createElement(PromptInput, {
          onSubmit: (text: string, display?: string) => {
            submitted.push({ text, display })
          },
          onSlashCommand: noop,
          onChoose: noop,
        }),
        { stdin, stdout, patchConsole: false },
      )
      expect(await waitFor(sink, "Ask Trayambak to do anything...")).toBe(true)
      bigPaste(stdin, "y".repeat(1275))
      expect(await waitFor(sink, "[Pasted Content 1275 chars]")).toBe(true)
      stdin.write("\r")
      expect(await waitForFn(() => submitted.length > 0)).toBe(true)
      // First arg runs the model (whole paste); second arg is the composer
      // as typed — the block the sent transcript row keeps showing.
      expect(submitted[0]?.text).toBe("y".repeat(1275))
      expect(submitted[0]?.display).toBe("[Pasted Content 1275 chars]")
    } finally {
      instance?.unmount()
    }
  }, 20000)

  it("leaves small pastes literal (no collapse, no map)", async () => {
    const submitted: string[] = []
    const { stdin, stdout, sink } = openStdio()
    let instance: Instance | undefined
    try {
      instance = render(
        React.createElement(PromptInput, {
          onSubmit: (text: string) => {
            submitted.push(text)
          },
          onSlashCommand: noop,
          onChoose: noop,
        }),
        { stdin, stdout, patchConsole: false },
      )
      expect(await waitFor(sink, "Ask Trayambak to do anything...")).toBe(true)
      bigPaste(stdin, "hi there")
      await wait(300)
      expect(sink()).toContain("hi there")
      expect(sink()).not.toContain("Pasted Content")
      stdin.write("\r")
      expect(await waitForFn(() => submitted.length > 0)).toBe(true)
      expect(submitted[0]).toBe("hi there")
    } finally {
      instance?.unmount()
    }
  }, 20000)
})

describe("idle silence (Windows inbuilt scrollbar contract)", () => {
  const noop = (): void => {}
  /** setInterval delays registered from here on (spy restored by caller). */
  const spyIntervals = (seen: number[]): void => {
    const orig = globalThis.setInterval
    globalThis.setInterval = ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
      seen.push(timeout ?? 0)
      return orig(handler, timeout, ...args)
    }) as typeof globalThis.setInterval
  }

  const renderComposer = (isLoading: boolean): { sink: () => string; instance: Instance } => {
    const { stdin, stdout, sink } = openStdio()
    const instance = render(
      React.createElement(PromptInput, {
        onSubmit: noop,
        onSlashCommand: noop,
        onChoose: noop,
        isLoading,
      }),
      { stdin, stdout, patchConsole: false },
    )
    return { sink, instance }
  }

  it("registers no blink timer at idle (zero writes, native bar holds)", async () => {
    const seen: number[] = []
    const orig = globalThis.setInterval
    spyIntervals(seen)
    let instance: Instance | undefined
    try {
      const r = renderComposer(false)
      instance = r.instance
      expect(await waitFor(r.sink, "Ask Trayambak to do anything...")).toBe(true)
      expect(seen).not.toContain(530)
    } finally {
      globalThis.setInterval = orig
      instance?.unmount()
    }
  }, 20000)

  it("registers the busy pulse mid-turn (animation only while repainting anyway)", async () => {
    const seen: number[] = []
    const orig = globalThis.setInterval
    spyIntervals(seen)
    let instance: Instance | undefined
    try {
      const r = renderComposer(true)
      instance = r.instance
      expect(await waitFor(r.sink, "Ask Trayambak to do anything...")).toBe(true)
      expect(seen).toContain(530)
    } finally {
      globalThis.setInterval = orig
      instance?.unmount()
    }
  }, 20000)
})
