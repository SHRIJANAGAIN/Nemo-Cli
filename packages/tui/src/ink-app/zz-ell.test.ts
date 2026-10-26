import path from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import React from "react"

const ANSI = path.join(process.cwd(), "packages", "tui", "src", "ink-app", "logo_ansi.txt")

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe("zz ellipsis", () => {
  it("reports ellipsis per width", async () => {
    vi.resetModules()
    process.env.NEMO_LOGO_PATH = ANSI
    const { render, Box } = await import("ink")
    const { NemoLogo } = await import("./NemoLogo.js")
    for (const columns of [80, 100, 118]) {
      const pass = new PassThrough()
      let sink = ""
      pass.on("data", (c) => (sink += c.toString()))
      const stdout = Object.assign(pass, { isTTY: true, columns, rows: 30 }) as unknown as NodeJS.WriteStream
      const frameWidth = columns - 4
      const instance = render(
        React.createElement(
          Box,
          { flexDirection: "column", borderStyle: "round", height: 20, backgroundColor: "#1a1b26" },
          React.createElement(
            Box,
            { flexDirection: "column", paddingX: 1 },
            React.createElement(NemoLogo, { compact: false, width: frameWidth - 30 }),
          ),
        ),
        { stdout, patchConsole: false },
      )
      await wait(300)
      instance.unmount()
      await wait(30)
      const rows = sink
        .split("\n")
        .map((l) => l.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""))
        .filter((l) => l.trim() !== "")
      const ellipsis = rows.filter((l) => l.includes("\u2026")).length
      const widths = rows.map((l) => [...l].length)
      process.stdout.write(
        `COLS=${columns} frameW=${frameWidth} rows=${rows.length} ellipsisRows=${ellipsis} maxW=${Math.max(...widths)}\n`,
      )
      for (const l of rows.filter((x) => x.includes("\u2026")).slice(0, 1)) {
        process.stdout.write(`   ELL len=${[...l].length} tail=${JSON.stringify(l.slice(-24))}\n`)
      }
    }
    expect(true).toBe(true)
  }, 30000)
})