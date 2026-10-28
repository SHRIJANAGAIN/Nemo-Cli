/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The render contract, end to end through MessageRow/ToolCallItem:
 *
 * - ASSISTANT messages render markdown — a real answer containing a GFM
 *   table must reach the screen without raw `|`, backticks, or the
 *   alignment row (the literal screenshot regression: a Snake Game root
 *   listing painted with pipes and dashes).
 * - TOOL output is VERBATIM — no markdown parsing at all. Logs, diffs, and
 *   code are data: italicizing a `*` or re-linking an `[x](y)` rewrites
 *   what the tool actually said.
 */

import React from "react"
import { render, type Instance } from "ink"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { MessageRow } from "./MessageRow.js"
import { ToolCallItem } from "./ToolCallItem.js"
import type { NemoMessage, ToolCallDisplay } from "./types.js"

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

async function renderNode(node: React.ReactElement): Promise<string> {
  const pass = new PassThrough()
  let sink = ""
  pass.on("data", (c) => (sink += c.toString()))
  const stdout = Object.assign(pass, { isTTY: true, columns: 100, rows: 40 }) as unknown as NodeJS.WriteStream
  let instance: Instance | undefined
  try {
    instance = render(node, { stdout, patchConsole: false })
    await wait(300)
  } finally {
    instance?.unmount()
  }
  await wait(30)
  return stripAnsi(sink)
}

function renderRow(message: NemoMessage): Promise<string> {
  return renderNode(React.createElement(MessageRow, { message }))
}

/** The exact answer from the bug report — pipes, dashes, backticked cells. */
const SCREENSHOT_ANSWER = [
  "Here's the project root. Key files from the Snake Game project (per AGENTS.md):",
  "",
  "| File | Description |",
  "|------|-------------|",
  "| `snake.py` | Python game implementation (requires pygame) |",
  "| `snake.html` | HTML game interface (runs in browser) |",
  "| `README.md` | Project overview and instructions |",
  "",
  "The directory also contains many auxiliary files, test scripts, and other project folders.",
].join("\n")

describe("assistant messages render markdown (no raw symbols)", () => {
  it("paints the reported table answer without |, backticks, or the alignment row", async () => {
    const message = { id: "a1", timestamp: 1, role: "assistant", content: SCREENSHOT_ANSWER } as NemoMessage
    const frame = await renderRow(message)

    // Content survives…
    expect(frame).toContain("snake.py")
    expect(frame).toContain("Description")
    expect(frame).toContain("Project overview and instructions")
    // …raw syntax never reaches the screen.
    expect(frame).not.toContain("|") // pipes → aligned `│` table
    expect(frame).not.toContain("`") // `cell` → styled code span
    expect(frame).not.toContain("---") // alignment row swallowed
    // Columns ALIGN: every `│` sits at the same index (code cells are
    // measured post-backtick, so `snake.py` doesn't shift its column).
    const sepCols = new Set(
      frame
        .split("\n")
        .map((line) => line.indexOf("│"))
        .filter((idx) => idx >= 0),
    )
    expect(sepCols.size).toBe(1)
  }, 15000)

  it("renders headings/bold/list markers away in the parts (streaming) path too", async () => {
    const message = {
      id: "a2",
      timestamp: 1,
      role: "assistant",
      content: "",
      parts: [{ text: { type: "text", text: "### Summary\n\n- **done**\n- `next`" } }],
    } as unknown as NemoMessage
    const frame = await renderRow(message)

    expect(frame).toContain("Summary")
    expect(frame).toContain("done")
    expect(frame).not.toContain("###")
    expect(frame).not.toContain("**")
    expect(frame).not.toContain("`")
  }, 15000)
})

describe("tool output is verbatim (no markdown)", () => {
  it("tool result rows show markdown characters exactly as produced", async () => {
    const message = {
      id: "t1",
      timestamp: 1,
      role: "tool",
      content: "**not bold** and `code` and [x](y) and ### heading",
      toolName: "bash",
    } as NemoMessage
    const frame = await renderRow(message)

    expect(frame).toContain("**not bold**")
    expect(frame).toContain("`code`")
    expect(frame).toContain("[x](y)")
    expect(frame).toContain("### heading")
  }, 15000)

  it("ToolCallItem result lines are verbatim too", async () => {
    const toolCall: ToolCallDisplay = {
      id: "c1",
      name: "bash",
      args: { command: "cat out.md" },
      status: "completed",
      result: "line **not bold** with `code` inside",
    }
    const frame = await renderNode(React.createElement(ToolCallItem, { toolCall }))

    expect(frame).toContain("**not bold**")
    expect(frame).toContain("`code`")
  }, 15000)
})
