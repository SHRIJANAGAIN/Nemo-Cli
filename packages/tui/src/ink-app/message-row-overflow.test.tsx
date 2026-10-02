/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Yoga overflow guard: a tool result collapsed to ONE giant single line
 * (whitespace folded, e.g. a base64 blob) must never take down the renderer
 * (`RuntimeError: memory access out of bounds` in yoga's getComputedWidth,
 * observed live in the published TUI). Expanded view shows the full text,
 * so over-long unbroken runs are hard-wrapped for measurement safety —
 * content preserved, only visual line breaks added.
 */

import React from "react"
import { render, type Instance } from "ink"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { MessageRow } from "./MessageRow.js"
import { MessageList } from "./MessageList.js"
import type { TrayambakMessage } from "./types.js"

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function renderRow(message: TrayambakMessage, columns = 100, expandOutput = false): Promise<string> {
  const pass = new PassThrough()
  let sink = ""
  pass.on("data", (c) => (sink += c.toString()))
  const stdout = Object.assign(pass, { isTTY: true, columns, rows: 40 }) as unknown as NodeJS.WriteStream
  let instance: Instance | undefined
  try {
    instance = render(React.createElement(MessageRow, { message, expandOutput }), {
      stdout,
      patchConsole: false,
    })
    await wait(300)
  } finally {
    instance?.unmount()
  }
  await wait(30)
  return sink
}

function toolMessage(content: string): TrayambakMessage {
  return { id: "t1", timestamp: 1, role: "tool", content, toolName: "bash" } as TrayambakMessage
}

describe("MessageRow yoga overflow guard", () => {
  it("renders a 20k-char unbroken tool line expanded without crashing", async () => {
    const sink = await renderRow(toolMessage("A".repeat(20000)), 100, /*expandOutput*/ true)
    expect(sink.length).toBeGreaterThan(0)
  }, 15000)

  it("marks truncation past the 20k expanded cap", async () => {
    const sink = await renderRow(toolMessage("Z".repeat(25000)), 100, /*expandOutput*/ true)
    expect(sink.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")).toContain("truncated")
  }, 15000)

  it("still collapses to the one-line preview by default", async () => {
    const sink = await renderRow(toolMessage(`line one\nline two ${"B".repeat(500)}`), 100, /*expandOutput*/ false)
    expect(sink).toContain("…")
  }, 15000)

  it("survives adversarial unicode: astral, ZWJ, combining, RTL in one line", async () => {
    const nasty =
      "A".repeat(1000) +
      "😀".repeat(500) +
      "́".repeat(500) +
      "日本語".repeat(400) +
      "👨‍👩‍👧".repeat(200) +
      "¿þаписииIMPlassungjourсe".repeat(300)
    const sink = await renderRow(toolMessage(nasty), 100, /*expandOutput*/ true)
    expect(sink.length).toBeGreaterThan(0)
  }, 15000)

  it("survives a 200k unbroken line on a narrow 20-column terminal", async () => {
    const sink = await renderRow(toolMessage("B".repeat(200000)), 20, /*expandOutput*/ true)
    expect(sink.length).toBeGreaterThan(0)
  }, 30000)

  it("survives a 100k unbroken assistant line (streaming babble shape)", async () => {
    const message: TrayambakMessage = {
      id: "a1",
      timestamp: 1,
      role: "assistant",
      content: "C".repeat(100000),
    } as TrayambakMessage
    const sink = await renderRow(message, 100, /*expandOutput*/ false)
    expect(sink.length).toBeGreaterThan(0)
  }, 30000)

  it("survives a giant history: 300 tool rows with multi-KB outputs at once", async () => {
    const messages: TrayambakMessage[] = Array.from({ length: 300 }, (_, i) => ({
      id: `m${i}`,
      timestamp: i,
      role: "tool",
      content: `result ${i}\n${"x".repeat(150)} ${"y".repeat(1500)}\nend ${i}`,
      toolName: "bash",
    })) as TrayambakMessage[]
    const pass = new PassThrough()
    let sink = ""
    pass.on("data", (c) => (sink += c.toString()))
    const stdout = Object.assign(pass, { isTTY: true, columns: 100, rows: 40 }) as unknown as NodeJS.WriteStream
    let instance: Instance | undefined
    try {
      instance = render(React.createElement(MessageList, { messages }), { stdout, patchConsole: false })
      await wait(500)
    } finally {
      instance?.unmount()
    }
    await wait(30)
    expect(sink.length).toBeGreaterThan(0)
  }, 30000)
})
