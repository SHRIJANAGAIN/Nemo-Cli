/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import React from "react"
import { PassThrough } from "node:stream"
import { render, type Instance } from "ink"
import { SubagentPanel } from "./SubagentPanel.js"
import type { NemoMessage } from "./types.js"

/**
 * Narrow-panel regression: the title row was 7 unbounded Texts
 * (title + [source] + type + worktree + duration + toolcalls ≈ 113 cols),
 * pushing the panel border past a 100-col terminal into wrapped garbage.
 * Only the title shrinks now, with truncate-end.
 */

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

describe("SubagentPanel narrow terminal", () => {
  it("keeps a long title row inside 100 cols (title truncates, badges survive)", async () => {
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
      columns: 100,
      rows: 30,
    }) as unknown as NodeJS.WriteStream

    const cards: NemoMessage[] = [
      {
        id: "card-1",
        timestamp: Date.now() - 5000,
        role: "assistant",
        content: "Explore the nemo directory exhaustively and report every bug",
        subagentId: "s1",
        subagentState: "completed",
        subagentType: "explore",
        subagentIsolation: "worktree",
        subagentToolCalls: 12,
      },
    ]

    let instance: Instance | undefined
    try {
      instance = render(
        React.createElement(SubagentPanel, {
          cards,
          background: [],
          initialTab: "all",
          onClose: () => {},
        }),
        { stdin, stdout, patchConsole: false },
      )
      const start = Date.now()
      while (!stripAnsi(captured).includes("Subagents") && Date.now() - start < 3000) {
        await wait(25)
      }
      const lines = captured.split(/\r?\n/).map(stripAnsi)
      expect(lines.some((l) => l.includes("Subagents"))).toBe(true)
      // Title visible (possibly truncated) + badges intact …
      expect(captured).toContain("Explore the nemo")
      expect(captured).toContain("[foreground]")
      expect(captured).toContain("12 toolcalls")
      // … and no row escapes the terminal (old overflow ≈ 113).
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(101)
      }
    } finally {
      instance?.unmount()
    }
  }, 15000)
})
