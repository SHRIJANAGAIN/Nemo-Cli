/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, describe, expect, it } from "vitest"
import React from "react"
import { PassThrough } from "node:stream"
import { Box, Text, render, type Instance } from "ink"
import { resetGlyphCache } from "./glyphs.js"
import { liveViewportRows, welcomeFillRows, welcomeLogoCompact } from "./app-bootstrap.js"
import { WelcomeScreen, formatClock, formatDate, shortPath } from "./WelcomeScreen.js"

describe("formatClock", () => {
  it("zero-pads hours, minutes and seconds", () => {
    expect(formatClock(new Date(2026, 0, 2, 3, 4, 5))).toBe("03:04:05")
    expect(formatClock(new Date(2026, 0, 2, 23, 59, 59))).toBe("23:59:59")
    expect(formatClock(new Date(2026, 0, 2, 0, 0, 0))).toBe("00:00:00")
    expect(formatClock(new Date(2026, 0, 2, 9, 8, 7))).toBe("09:08:07")
  })

  it("always renders HH:MM:SS (8 chars) so the line never reflows", () => {
    for (let h = 0; h < 24; h += 1) {
      expect(formatClock(new Date(2026, 0, 2, h, 0, 0))).toHaveLength(8)
    }
  })
})

describe("formatDate", () => {
  it("renders an ASCII weekday + month + day", () => {
    expect(formatDate(new Date(2026, 0, 2, 12))).toBe("Fri Jan 2")
    expect(formatDate(new Date(2026, 11, 25, 12))).toBe("Fri Dec 25")
  })

  it("never emits non-ASCII (mojibake guard for legacy consoles)", () => {
    for (let d = 0; d < 365; d += 1) {
      const line = formatDate(new Date(2026, 0, 1 + d, 12))
      expect(line).toMatch(/^[A-Za-z]{3} [A-Za-z]{3} \d{1,2}$/)
      expect(/^[\x20-\x7e]+$/.test(line)).toBe(true)
    }
  })
})

describe("shortPath", () => {
  it("reduces a path to its folder name", () => {
    expect(shortPath("C:/Users/engli/trayambak")).toBe("trayambak")
    expect(shortPath("C:\\Users\\engli\\Default Project")).toBe("Default Project")
    expect(shortPath("/home/engli/app")).toBe("app")
  })

  it("trims a trailing separator before taking the last segment", () => {
    // Otherwise a trailing separator yields an empty last segment.
    expect(shortPath("C:/a/b/")).toBe("b")
    expect(shortPath("C:\\a\\b\\\\")).toBe("b")
  })

  it("handles no path and a bare root", () => {
    expect(shortPath(undefined)).toBe("")
    expect(shortPath("")).toBe("")
    expect(shortPath("/")).toBe("")
  })

  it("never leaks a separator or parent traversal into the label", () => {
    // The label sits in the status block beside a fixed-width key, so a
    // separator here would read as a column misalignment.
    for (const p of ["C:/a/b", "/home/engli", "relative/folder"]) {
      expect(shortPath(p)).not.toMatch(/[\\/]/)
    }
  })
})

/**
 * What the welcome screen actually PAINTS. The pure helpers above can pass while
 * the component still shows the old block, so the two facts that changed are
 * pinned against a real render: the folder label is the folder NAME, and the
 * model line is gone from under the logo.
 */
describe("WelcomeScreen status block", () => {
  resetGlyphCache()

  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  const openStdio = (columns: number): { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream; sink: () => string } => {
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
    const stdout = Object.assign(rawOut, { isTTY: true, columns, rows: 40 }) as unknown as NodeJS.WriteStream
    return { stdin, stdout, sink: () => captured }
  }

  let instance: Instance | undefined

  afterEach(() => {
    instance?.unmount()
    instance = undefined
    resetGlyphCache()
  })

  it("shows only the folder name, never the full path", async () => {
    const { stdin, stdout, sink } = openStdio(120)
    instance = render(React.createElement(WelcomeScreen, { cwd: "C:\\Users\\engli\\trayambak", width: 110 }), {
      stdin,
      stdout,
      patchConsole: false,
    })
    await wait(200)
    const out = sink().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    expect(out).toContain("trayambak")
    // The path prefix must never reach the screen.
    expect(out).not.toContain("C:\\Users")
    expect(out).not.toContain("C:/Users")
  }, 15000)

  it("does not repeat the model name under the logo", async () => {
    const { stdin, stdout, sink } = openStdio(120)
    instance = render(React.createElement(WelcomeScreen, { cwd: "C:\\Users\\engli\\trayambak", width: 110 }), {
      stdin,
      stdout,
      patchConsole: false,
    })
    await wait(200)
    const out = sink().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    // The footer chip owns the model name; the welcome block must not.
    expect(out).not.toMatch(/^\s*model\s{2,}\S/m)
  }, 15000)

  it("labels the folder Directory, never cwd", async () => {
    const { stdin, stdout, sink } = openStdio(120)
    instance = render(React.createElement(WelcomeScreen, { cwd: "C:\\Users\\engli\\trayambak", width: 110 }), {
      stdin,
      stdout,
      patchConsole: false,
    })
    await wait(200)
    const out = sink().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    expect(out).toMatch(/Directory\s+trayambak/)
    expect(out).not.toMatch(/^\s*cwd\s/m)
  }, 15000)
})

/**
 * The idle frame must never be taller than the viewport — not even for the one
 * render where React state still holds the PRE-resize size.
 *
 * That one stale render is the whole clone mechanism: Ink re-renders on resize
 * from its own listener before useTerminalRows' setState lands, so a frame
 * sized from state describes a window that no longer exists. Past the bottom
 * row the console scrolls, and every repaint after it scrolls again — full
 * frames stacking up in scrollback (reported live as the same Welcome screen
 * copy-pasted after every resize).
 *
 * These render the REAL WelcomeScreen (real logo asset, real fill math) inside
 * the same chrome shape App uses — bordered root of height viewport-1, a 3-row
 * footer panel and a 2-row composer — and count SCREEN rows with terminal
 * wrapping applied. Screen rows over budget means the terminal scrolled, which
 * means clones.
 */
describe("idle frame fits the viewport (no resize clones)", () => {
  resetGlyphCache()

  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  const openFrameStdio = (
    columns: number,
    rows: number,
  ): { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream; sink: () => string } => {
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
    const stdout = Object.assign(rawOut, { isTTY: true, columns, rows }) as unknown as NodeJS.WriteStream
    return { stdin, stdout, sink: () => captured }
  }

  let instance: Instance | undefined

  afterEach(() => {
    instance?.unmount()
    instance = undefined
    resetGlyphCache()
  })

  /** Screen rows a stripped frame occupies once the terminal wraps long lines. */
  function screenRows(stripped: string, columns: number): number {
    let rows = 0
    for (const line of stripped.split("\n")) {
      const cells = [...line].length
      rows += Math.max(1, Math.ceil(cells / Math.max(1, columns)))
    }
    return rows
  }

  /**
   * Bytes of the LAST fully painted frame. The clock repaints every 500ms, so
   * the sink can hold several frames; counting all of them would mistake a
   * healthy repaint for an overflowing one. Ink erases with EL (ESC[2K)
   * sequences before rewriting, so everything after the final EL run is the
   * live frame.
   */
  function lastFrame(captured: string): string {
    const parts = captured.split(/\x1b\[2K/)
    return (parts.length > 0 ? parts[parts.length - 1]! : captured).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
  }

  async function renderIdleFrame(columns: number, liveRows: number, stateRows: number): Promise<number> {
    const { stdin, stdout, sink } = openFrameStdio(columns, liveRows)
    // Exactly App's wiring: live geometry wins, stale React state loses.
    const viewportRows = liveViewportRows(stdout.rows, stateRows)
    const width = Math.max(20, (stdout.columns ?? 80) - 4)
    const tree = React.createElement(
      Box,
      { flexDirection: "column", height: Math.max(1, viewportRows - 1), borderStyle: "round" },
      React.createElement(
        Box,
        { flexDirection: "column", flexGrow: 1 },
        React.createElement(WelcomeScreen, {
          cwd: "C:\\Users\\engli\\trayambak",
          fillRows: welcomeFillRows(viewportRows),
          width,
          logoCompact: welcomeLogoCompact(viewportRows),
        }),
      ),
      React.createElement(
        Box,
        { flexDirection: "column", flexShrink: 0, borderStyle: "round" },
        React.createElement(Text, null, "footer"),
      ),
      React.createElement(
        Box,
        { flexDirection: "column", flexShrink: 0, marginTop: 1 },
        React.createElement(Text, null, "> prompt"),
      ),
    )
    instance = render(tree, { stdin, stdout, patchConsole: false })
    await wait(200)
    const frame = lastFrame(sink())
    instance?.unmount()
    instance = undefined
    return screenRows(frame, columns)
  }

  it.each([
    { columns: 118, liveRows: 40, stateRows: 40 },
    { columns: 118, liveRows: 27, stateRows: 27 },
    { columns: 110, liveRows: 30, stateRows: 30 },
    { columns: 100, liveRows: 30, stateRows: 30 },
  ])("fits a $columns x $liveRows viewport (state $stateRows)", async ({ columns, liveRows, stateRows }) => {
    expect(await renderIdleFrame(columns, liveRows, stateRows)).toBeLessThanOrEqual(liveRows)
  }, 15000)

  it("fits even when React state still holds the PRE-resize size (the clone render)", async () => {
    // The exact failure: window shrank 40 -> 27 but state has not caught up.
    // Old code sized the frame from state (39-row frame into a 27-row window
    // = scroll = clones); the live read must hold it to 27.
    expect(await renderIdleFrame(118, 27, 40)).toBeLessThanOrEqual(27)
  }, 15000)

  it("drops to the compact mark (not an overflowing lockup) on short viewports", async () => {
    const { stdin, stdout, sink } = openFrameStdio(118, 20)
    const viewportRows = liveViewportRows(stdout.rows, 20)
    expect(welcomeLogoCompact(viewportRows)).toBe(true)
    instance = render(
      React.createElement(WelcomeScreen, {
        cwd: "C:\\repo",
        fillRows: welcomeFillRows(viewportRows),
        width: 110,
        logoCompact: welcomeLogoCompact(viewportRows),
      }),
      { stdin, stdout, patchConsole: false },
    )
    await wait(200)
    const frame = lastFrame(sink())
    expect(screenRows(frame, 118)).toBeLessThanOrEqual(20)
    expect(frame).toContain("TRAYAMBAK")
  }, 15000)
})