/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import React from "react"
import fs from "node:fs"
import path from "node:path"
import { PassThrough } from "node:stream"
import { render } from "ink"
import { WelcomeScreen } from "./WelcomeScreen.js"

/**
 * Renders the welcome screen with the REAL baked banner and reports any cell
 * left without a background colour — which is exactly what appears on screen as
 * a black patch. The unit test asserts this on the asset; this one asserts it
 * through the full render path, including padLogoToTheme and Ink's own layout,
 * because a themed payload can still be dropped by the renderer.
 */
describe("welcome screen paints every blank with the theme background", () => {
  it("leaves no unthemed cell anywhere on screen", async () => {
    const out = path.join(process.cwd(), ".diag-welcome-logo.txt")
    fs.copyFileSync(
      path.join(process.cwd(), "packages", "tui", "src", "ink-app", "logo_ansi.txt"),
      out,
    )
    process.env.TRAYAMBAK_LOGO_PATH = out
    try {
      const pass = new PassThrough()
      let sink = ""
      pass.on("data", (c: Buffer) => (sink += c.toString()))
      const stdout = Object.assign(pass, { isTTY: true, columns: 120, rows: 40 }) as unknown as NodeJS.WriteStream

      const instance = render(
        React.createElement(WelcomeScreen, { cwd: "C:\\repo", fillRows: 0, width: 116 }),
        { stdout, patchConsole: false },
      )
      await new Promise((r) => setTimeout(r, 400))
      instance.unmount()
      await new Promise((r) => setTimeout(r, 50))

      let checked = 0
      let unthemed = 0
      for (const line of sink.split("\n")) {
        let bg: string | null = null
        const re = /\x1b\[([0-9;]*)m([\s\S]*?)(?=\x1b\[|$)/g
        let m: RegExpExecArray | null
        while ((m = re.exec(line)) !== null) {
          const sgr = m[1] ?? ""
          if (sgr === "0" || sgr === "") bg = null
          else if (sgr.startsWith("48;")) bg = sgr
          for (const ch of m[2] ?? "") {
            if (ch === " ") {
              checked++
              if (bg === null) unthemed++
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(100)
      expect(unthemed).toBe(0)
    } finally {
      fs.rmSync(out, { force: true })
      delete process.env.TRAYAMBAK_LOGO_PATH
    }
  }, 20000)
})