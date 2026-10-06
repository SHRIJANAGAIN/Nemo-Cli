/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Startup clear contract — the one place this terminal is allowed to wipe.
 *
 * Three requirements have to hold together, and earlier attempts broke one each:
 *
 *  - No PowerShell banner. `\x1b[2J` alone does NOT achieve this: it clears the
 *    viewport, the banner survives in the scrollback, and it comes back on the
 *    first scroll up. ED3 (`\x1b[3J`) is what actually removes it.
 *  - Scrolling up works, and auto-scroll follows generation. So the clear must
 *    happen ONCE, before the renderer exists, and nothing may clear scrollback
 *    afterwards. The renderer's flicker recovery used to emit ED3 on every
 *    resize, deleting the printed transcript; that path is screen-only now
 *    (`trayambak-ink/core/clearTerminal.ts`).
 *  - The alternate screen is never used. Its buffer has no scrollback at all, so
 *    rows the UI settles into <Static> become unreachable.
 *
 * The repl tree is excluded from vitest discovery, so this lives one level up
 * and reads the entrypoint by path.
 */
import { readFileSync } from "fs"
import * as path from "path"
import { describe, expect, it } from "vitest"

const source = readFileSync(path.resolve(process.cwd(), "packages/tui/src/repl/ink-repl.mjs"), "utf8")

/** Escapes actually handed to stdout, ignoring comment lines. */
function rawEscapeWrites(): string[] {
  const code = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
  return [...code.matchAll(/write\(\s*["'`]([^"'`]*\\x1b[^"'`]*)["'`]/g)].map((m) => m[1] ?? "")
}

describe("ink-repl startup clear", () => {
  it("writes exactly one escape sequence, and it is the startup clear", () => {
    // A second writer is how the frame got desynchronised from the renderer
    // before; one deliberate write, or none.
    expect(rawEscapeWrites()).toHaveLength(1)
  })

  it("turns OFF every mouse-reporting mode so the device scrollbar keeps working", () => {
    const seq = rawEscapeWrites()[0] ?? ""
    // While any of these is ON the terminal routes wheel/drag to the app
    // instead of scrolling its own buffer, so the scrollbar dies and the
    // transcript looks frozen. The app never enables reporting, so these only
    // clear a mode left behind by a killed run.
    for (const mode of ["1000", "1002", "1003", "1006", "1015"]) {
      expect(seq, mode).toContain(`\\x1b[?${mode}l`)
      expect(seq, mode).not.toContain(`\\x1b[?${mode}h`)
    }
  })

  it("erases the scrollback, which is the only thing that removes the banner", () => {
    expect(rawEscapeWrites().some((seq) => seq.includes("[3J"))).toBe(true)
  })

  it("erases the viewport, homes the cursor, and clears scrollback", () => {
    const seq = rawEscapeWrites()[0] ?? ""
    expect(seq).toContain("[2J")
    expect(seq).toContain("[3J")
    expect(seq).toContain("[H")
  })

  it("never takes the alternate screen — that buffer has no scrollback", () => {
    expect(rawEscapeWrites().some((seq) => seq.includes("1049"))).toBe(false)
  })

  it("claims the terminal before the first render, so there is no frame state to desync", () => {
    const write = source.indexOf('process.stdout.write("\\x1b[2J')
    const render = source.indexOf("const instance = render(")
    expect(write).toBeGreaterThan(-1)
    expect(render).toBeGreaterThan(-1)
    expect(write).toBeLessThan(render)
  })

  it("only clears on a TTY so piped and CI output stays clean", () => {
    expect(source).toContain("process.stdout.isTTY === true")
  })

  it("leaves cursor visibility to the app, which declares its own caret", () => {
    expect(rawEscapeWrites().some((seq) => seq.includes("[?25"))).toBe(false)
  })

  it("carries no exit-path restore scaffolding — nothing to restore", () => {
    expect(source).not.toContain("restoreTerminal")
    expect(source).not.toContain('process.on("exit"')
  })

  it("states the cost it accepts, so nobody is surprised by it later", () => {
    expect(source).toContain("scrollback is erased along with")
  })

  it("still renders and attaches the resize guard", () => {
    expect(source).toContain("const instance = render(")
    expect(source).toContain("resizeGuard.attach(instance)")
    expect(source).toContain("export { TrayambakApp }")
  })
})
