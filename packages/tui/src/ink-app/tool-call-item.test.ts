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
import { ToolCallItem } from "./ToolCallItem.js"
import type { ToolCallDisplay } from "./types.js"

/**
 * Narrow-terminal header regression: with labels/args/mark as sibling flex
 * rows, any header whose natural width exceeded the box (≤119-col terminals
 * with a 100-char args slice) made yoga push the shrink-free label boxes to
 * a SECOND line while args/✓ stayed on the first — "Called bash" painted
 * below its own arguments. The header is now one truncating <Text>; these
 * tests pin "one line at 119 cols" (the reported width) and at 100.
 */

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

async function headerLineAt(columns: number, toolCall: ToolCallDisplay, expandOutput = false): Promise<string[]> {
  const raw = new PassThrough()
  let sink = ""
  raw.on("data", (c) => (sink += c.toString()))
  const stdout = Object.assign(raw, { isTTY: true, columns, rows: 40 }) as unknown as NodeJS.WriteStream

  let instance: Instance | undefined
  try {
    instance = render(
      React.createElement(ToolCallItem, {
        toolCall,
        shouldShowDot: true,
        addMargin: false,
        width: columns,
        expandOutput,
      }),
      { stdout, patchConsole: false },
    )
    const start = Date.now()
    while (!sink.includes("✓") && Date.now() - start < 3000) await wait(25)
  } finally {
    instance?.unmount()
  }
  await wait(30)
  return sink.split(/\r?\n/).map(stripAnsi)
}

const LONG_ARGS_TOOL: ToolCallDisplay = {
  id: "t1",
  name: "bash",
  args: {
    value: 'We need to list the trayambak directory. The user said "list trayambak directory". We sa',
  },
  status: "completed",
  result: "total 146844",
}

// Glyphs under test render through glyphs.ts, which auto-selects ASCII on
// plain Windows consoles (this CI/dev box) — assertions below pin Unicode
// shapes, so force unicode mode here. resetGlyphCache covers shared workers.
process.env.TRAYAMBAK_GLYPHS = "unicode"
resetGlyphCache()
describe("ToolCallItem header (single truncating line)", () => {
  it("keeps labels + args + ✓ on ONE line at 119 cols (reported width)", async () => {
    const lines = await headerLineAt(119, LONG_ARGS_TOOL)
    const hdrIdx = lines.findIndex((l) => l.includes("Called bash"))
    expect(hdrIdx).toBeGreaterThanOrEqual(0)
    // status mark rides the same line as the labels …
    expect(lines[hdrIdx]).toContain("✓")
    // … and "Called bash" never paints on a following line.
    expect(lines[hdrIdx + 1] ?? "").not.toContain("Called bash")
  }, 15000)

  it("stays one line at 100 cols (extreme narrow) too", async () => {
    const lines = await headerLineAt(100, LONG_ARGS_TOOL)
    const hdrIdx = lines.findIndex((l) => l.includes("Called bash"))
    expect(hdrIdx).toBeGreaterThanOrEqual(0)
    expect(lines[hdrIdx + 1] ?? "").not.toContain("Called bash")
  }, 15000)

  it("renders the mcp header as one line at 119 cols", async () => {
    const lines = await headerLineAt(119, {
      id: "t3",
      name: "navigate",
      args: { url: "https://trayambak.sktailabs.dev/docs/getting-started/install" },
      toolType: "mcp",
      server: "puppeteer",
      status: "completed",
      result: "ok",
    })
    const hdrIdx = lines.findIndex((l) => l.includes("puppeteer.navigate"))
    expect(hdrIdx).toBeGreaterThanOrEqual(0)
    expect(lines[hdrIdx]).toContain("✓")
    expect(lines[hdrIdx + 1] ?? "").not.toContain("puppeteer.navigate")
  }, 15000)

  it("stacks multi-line exec commands vertically at 100 cols (never side-by-side)", async () => {
    // Regression: the exec header was a row-in-row — "echo alpha" glued
    // next to "└ echo beta" on ONE visual line, the unbounded inner row
    // never let truncate-end fire, and ✓/duration got pushed off-screen.
    const lines = await headerLineAt(100, {
      id: "t4",
      name: "bash",
      toolType: "exec",
      command: "echo alpha\necho beta",
      args: {},
      status: "completed",
      result: "done",
    })
    expect(lines.some((l) => l.includes("✓"))).toBe(true)
    expect(lines.some((l) => l.includes("Ran"))).toBe(true)
    const alphaIdx = lines.findIndex((l) => l.includes("echo alpha"))
    const betaIdx = lines.findIndex((l) => l.includes("echo beta"))
    expect(alphaIdx).toBeGreaterThanOrEqual(0)
    expect(betaIdx).toBeGreaterThanOrEqual(0)
    // Separate rows — never glued onto one visual line.
    expect(betaIdx).not.toBe(alphaIdx)
    // Border never stretched past the terminal.
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(101)
    }
  }, 15000)

  it("Ctrl+O unfold shows the full result, collapsed keeps head+tail", async () => {
    const result = Array.from({ length: 30 }, (_, i) => `line-${String(i).padStart(2, "0")}`).join("\n")
    const collapsed = await headerLineAt(120, {
      id: "t5",
      name: "bash",
      args: {},
      status: "completed",
      result,
    })
    expect(collapsed.some((l) => l.includes("line-00"))).toBe(true)
    expect(collapsed.some((l) => l.includes("line-29"))).toBe(true)
    expect(collapsed.some((l) => l.includes("line-15"))).toBe(false)
    const expanded = await headerLineAt(
      120,
      {
        id: "t5",
        name: "bash",
        args: {},
        status: "completed",
        result,
      },
      true,
    )
    for (const n of ["line-00", "line-15", "line-29"]) {
      expect(expanded.some((l) => l.includes(n))).toBe(true)
    }
  }, 15000)
})

// The running-border pulse has its own file (tool-call-pulse.test.ts): it
// needs FORCE_COLOR loaded BEFORE ink, which a static-import file can't do.
