/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import React from "react"
import { PassThrough } from "node:stream"
import { Box, render, type Instance } from "ink"
import { ToolCallItem } from "./ToolCallItem.js"
import { GroupedToolUseContent } from "./GroupedToolUseContent.js"
import type { ToolCallDisplay } from "./types.js"
import { stringWidth } from "./utils/stringWidth.js"

/**
 * Tool-box escape regression: a completed tool box painted its right edge
 * ONTO (or past) the fullscreen frame's right border — the box "escaped
 * the conversation box". Geometry: frame (border, full width) → static
 * area (width columns-1) → row marginLeft 1 → message marginLeft 1 →
 * tool box width="100%". Every rendered line must stay within `columns`,
 * and the tool box's own corners must sit strictly inside the frame edge.
 */

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

async function renderNested(columns: number, node: React.ReactNode): Promise<string[]> {
  const raw = new PassThrough()
  let sink = ""
  raw.on("data", (c) => (sink += c.toString()))
  const stdout = Object.assign(raw, { isTTY: true, columns, rows: 40 }) as unknown as NodeJS.WriteStream
  let instance: Instance | undefined
  try {
    // Faithful Static-area geometry (see MessageList.tsx: the Static box is
    // position:absolute at x=0 with width columns-1; rows carry marginLeft
    // 1, MessageRow adds one more). The fullscreen frame's right border
    // lives at columns-1, its content ends at columns-2 — modelled by the
    // assertions, not by paint (a wrapping frame would mask overruns).
    instance = render(
      React.createElement(
        Box,
        { width: columns - 1, flexDirection: "column" },
        React.createElement(
          Box,
          { marginLeft: 1, flexDirection: "column" },
          React.createElement(Box, { marginLeft: 1, flexDirection: "column" }, node),
        ),
      ),
      { stdout, patchConsole: false },
    )
    await wait(150)
  } finally {
    instance?.unmount()
  }
  await wait(30)
  return sink
    .split(/\r?\n/)
    .map(stripAnsi)
    .filter((l) => l.length > 0)
}

function expectFits(lines: string[], columns: number): void {
  for (const line of lines) {
    expect(stringWidth(line), `over-wide line: ${JSON.stringify(line.slice(0, 60))}`).toBeLessThanOrEqual(columns - 1)
  }
  // Bordered tool boxes keep a 1-col gutter from the frame content edge
  // (columns-2): a corner AT columns-2 sits flush against the frame's
  // content boundary and reads as escape (measured live: corner landed
  // exactly on the frame border column). Text rows may run to columns-2;
  // box corners must stay at or inside columns-3.
  for (const line of lines) {
    const corner = Math.max(line.lastIndexOf("┐"), line.lastIndexOf("┘"))
    if (corner >= 0) {
      expect(corner, `tool corner escapes: ${JSON.stringify(line.slice(-30))}`).toBeLessThanOrEqual(columns - 3)
    }
  }
}

const NORMAL_TOOL: ToolCallDisplay = {
  id: "t1",
  name: "list_dir",
  args: { path: "." },
  status: "completed",
  result: [
    "alpha/",
    "beta/",
    "gamma.txt",
    "delta.txt",
    "epsilon.txt",
    "zeta.txt",
    "eta.txt",
    "theta.txt",
    "iota.txt",
    "kappa.txt",
  ].join("\n"),
}

const EXEC_TOOL: ToolCallDisplay = {
  id: "t2",
  name: "bash",
  toolType: "exec",
  command: "ls -la /some/really/long/path/that/goes/on/and/on",
  args: {},
  status: "completed",
  result: "total 8\ndrwxr-xr-x 2 user user 4096 Jan 1 00:00 .\nfile with a very long name that keeps going.txt",
}

const MCP_TOOL: ToolCallDisplay = {
  id: "t3",
  name: "navigate",
  toolType: "mcp",
  server: "puppeteer",
  args: { url: "https://example.com/some/long/path?query=1&other=2" },
  status: "completed",
  result: "ok",
}

describe("ToolCallItem box fit (no escape past the frame)", () => {
  for (const columns of [100, 160]) {
    it(`normal tool box fits at ${columns} cols`, async () => {
      const lines = await renderNested(columns, React.createElement(ToolCallItem, { toolCall: NORMAL_TOOL }))
      expect(lines.length).toBeGreaterThan(0)
      expectFits(lines, columns)
    }, 15000)

    it(`exec tool box fits at ${columns} cols`, async () => {
      const lines = await renderNested(columns, React.createElement(ToolCallItem, { toolCall: EXEC_TOOL }))
      expect(lines.length).toBeGreaterThan(0)
      expectFits(lines, columns)
    }, 15000)

    it(`mcp tool box fits at ${columns} cols`, async () => {
      const lines = await renderNested(columns, React.createElement(ToolCallItem, { toolCall: MCP_TOOL }))
      expect(lines.length).toBeGreaterThan(0)
      expectFits(lines, columns)
    }, 15000)
  }

  it("grouped tool calls fit at 120 cols", async () => {
    const lines = await renderNested(
      120,
      React.createElement(GroupedToolUseContent, {
        toolName: "fs",
        toolCalls: [NORMAL_TOOL, { ...NORMAL_TOOL, id: "t1b" }],
      }),
    )
    expect(lines.length).toBeGreaterThan(0)
    expectFits(lines, 120)
  }, 15000)
})
