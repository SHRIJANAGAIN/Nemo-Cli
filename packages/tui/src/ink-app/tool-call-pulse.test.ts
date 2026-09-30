/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * "animation bada do": a RUNNING tool box chases a light around its
 * border every 160ms (use-border-pulse.ts); a finished box stays still.
 *
 * FORCE_COLOR must be set BEFORE ink/chalk is loaded: vitest runs stdout
 * as a pipe, so chalk's level is 0 and the colour-only change renders to
 * a byte-identical frame that ink never re-writes — the pulse would be
 * invisible to any assertion. Static imports below are safe (vitest /
 * react / node carry no chalk); ink + the component load dynamically
 * AFTER the env is set, then the env is restored in afterAll so later
 * test files in this worker keep their original colour mode.
 *
 * shouldShowDot is false in the "running" case so the bullet loader can't
 * write frames — the pulse is the only possible source of new bytes.
 */
const OLD_FORCE_COLOR = process.env.FORCE_COLOR
process.env.FORCE_COLOR = "3"

import { afterAll, describe, expect, it } from "vitest"
import { resetGlyphCache } from "./glyphs.js"
import React from "react"
import { PassThrough } from "node:stream"
import type { Instance } from "ink"

const { render } = await import("ink")
const { ToolCallItem } = await import("./ToolCallItem.js")

afterAll(() => {
  if (OLD_FORCE_COLOR === undefined) delete process.env.FORCE_COLOR
  else process.env.FORCE_COLOR = OLD_FORCE_COLOR
})

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const snap = (): {
  stdout: NodeJS.WriteStream
  sink: () => string
  cleanup: (i?: Instance) => void
  wait: (needle: string) => Promise<boolean>
} => {
  const raw = new PassThrough()
  let buf = ""
  raw.on("data", (c) => (buf += c.toString()))
  const stdout = Object.assign(raw, { isTTY: true, columns: 100, rows: 40 }) as unknown as NodeJS.WriteStream
  return {
    stdout,
    sink: () => buf,
    cleanup: (i) => i?.unmount(),
    wait: async (needle: string) => {
      const start = Date.now()
      while (!buf.includes(needle) && Date.now() - start < 3000) await wait(25)
      return buf.includes(needle)
    },
  }
}

// Glyphs under test render through glyphs.ts, which auto-selects ASCII on
// plain Windows consoles (this CI/dev box) — assertions below pin Unicode
// shapes, so force unicode mode here. resetGlyphCache covers shared workers.
process.env.TRAYAMBAK_GLYPHS = "unicode"
resetGlyphCache()
describe("ToolCallItem running-border pulse", () => {
  it("keeps re-rendering a running box (border colour cycles)", async () => {
    const h = snap()
    let instance: Instance | undefined
    try {
      instance = render(
        React.createElement(ToolCallItem, {
          toolCall: { id: "p1", name: "bash", args: { value: "loop" }, status: "running" },
          shouldShowDot: false,
          shouldAnimate: false,
          width: 100,
        }),
        { stdout: h.stdout, patchConsole: false },
      )
      expect(await h.wait("Calling")).toBe(true)
      const before = h.sink()
      await wait(320) // ≥1 chase tick (160ms)
      const after = h.sink()
      expect(after).not.toBe(before)
      expect(after.length).toBeGreaterThan(before.length)
    } finally {
      h.cleanup(instance)
    }
  }, 15000)

  it("leaves a finished box still (pulse timer torn down)", async () => {
    const h = snap()
    let instance: Instance | undefined
    try {
      instance = render(
        React.createElement(ToolCallItem, {
          toolCall: { id: "p2", name: "bash", args: { value: "done" }, status: "completed", result: "ok" },
          shouldShowDot: true,
          width: 100,
        }),
        { stdout: h.stdout, patchConsole: false },
      )
      expect(await h.wait("✓")).toBe(true)
      await wait(80) // let the last frame flush
      const before = h.sink()
      await wait(320)
      expect(h.sink()).toBe(before)
    } finally {
      h.cleanup(instance)
    }
  }, 15000)
})
