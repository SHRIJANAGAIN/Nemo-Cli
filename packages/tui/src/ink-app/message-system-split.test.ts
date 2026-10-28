/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import React from "react"
import { PassThrough } from "node:stream"
import { Box, render, type Instance } from "ink"
import { MessageList } from "./MessageList.js"

/**
 * Oversized SYSTEM messages keep their head: a 54-line /themes list lost
 * everything above the tail cut (including the ● live-theme marker) because
 * the eager head-print path only covered assistant rows — the tail-only
 * slice showed the end while the head was never printed anywhere. Same
 * data-loss class as a long answer, same cure: cut head/tail once and print
 * the head to scrollback.
 */

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

async function renderList(columns: number, rows: number, messages: unknown[]): Promise<string> {
  const raw = new PassThrough()
  let sink = ""
  raw.on("data", (c) => (sink += c.toString()))
  const stdout = Object.assign(raw, { isTTY: true, columns, rows }) as unknown as NodeJS.WriteStream
  let instance: Instance | undefined
  try {
    instance = render(
      React.createElement(
        Box,
        { width: columns, height: rows, borderStyle: "single", flexDirection: "column" },
        React.createElement(MessageList, {
          messages: messages as never,
          isLoading: false,
          isStreaming: false,
          staticEpoch: 1,
        }),
      ),
      { stdout, patchConsole: false },
    )
    await wait(300)
  } finally {
    instance?.unmount()
  }
  await wait(30)
  return stripAnsi(sink)
}

const THEMES_LIKE = [
  "Available themes:",
  ...Array.from({ length: 53 }, (_, i) => `   theme-${String(i).padStart(2, "0")} (dark)`),
].join("\n")

describe("MessageList oversized system rows", () => {
  it("prints the head to scrollback and keeps the tail in-frame (nothing lost)", async () => {
    const out = await renderList(140, 36, [
      { id: "u1", timestamp: 0, role: "user", content: "/themes" },
      { id: "s1", timestamp: 1, role: "system", content: THEMES_LIKE },
    ])
    expect(out).toContain("Available themes:")
    expect(out).toContain("theme-00")
    expect(out).toContain("theme-52")
  }, 15000)

  it("short system messages still render whole (no split artifacts)", async () => {
    const out = await renderList(140, 36, [
      { id: "u1", timestamp: 0, role: "user", content: "/stats" },
      { id: "s1", timestamp: 1, role: "system", content: "Token count: 80\nMessage count: 2" },
    ])
    expect(out).toContain("Token count: 80")
    expect(out).toContain("Message count: 2")
    expect(out).not.toContain("… +")
  }, 15000)
})
