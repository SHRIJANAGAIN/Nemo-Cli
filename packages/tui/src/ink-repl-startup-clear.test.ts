/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Startup clear contract — the one place this terminal touches the screen
 * before the renderer exists.
 *
 * Three requirements have to hold together, and earlier attempts broke one each:
 *
 *  - Viewport starts clean: `\x1b[2J` + `\x1b[H`, once, pre-render, so the
 *    host shell's banner is not the first thing under the frame.
 *  - Scrollback is NEVER touched at launch: ED3 (`\x1b[3J`) is forbidden
 *    here — scrollback IS the transcript, so the banner, prompt and earlier
 *    sessions stay intact above the app. (The only scrollback clear left in
 *    the product is the resize guard's shrink-settle, which reprints the
 *    transcript from item 0 after clearing; nothing may clear scrollback in
 *    the render path — the retired fork's renderer used to emit ED3 on every
 *    resize; the surviving path is screen-only.)
 *  - The alternate screen is OPT-IN (--alt-screen / NEMO_ALT_SCREEN=1),
 *    reached only through the TTY-gated resolveAltScreen gate — no raw 1049
 *    literal may appear in the entry file. Its buffer has no scrollback at
 *    all, so rows the UI settles into <Static> cannot be scrolled back to:
 *    default runs stay inline and the resize guard keeps them clone-free.
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
  it("writes exactly the two known escape sequences, both pre-render", () => {
    // A second writer is how the frame got desynchronised from the renderer
    // before; deliberate writes only, or none. The two literals are the
    // inline path's startup clear and the alt-screen path's mouse-off tail —
    // the 1049h/l sequences themselves live in app-bootstrap (single source)
    // and are only ever reached through enter/leaveAltScreen, so no raw 1049
    // literal may appear here (asserted below).
    expect(rawEscapeWrites()).toHaveLength(2)
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

  it("never erases the scrollback — it IS the transcript (no ED3 at launch)", () => {
    expect(rawEscapeWrites().some((seq) => seq.includes("[3J"))).toBe(false)
  })

  it("erases the viewport and homes the cursor, without touching scrollback", () => {
    // The full clear is the default inline path's literal (the alt path writes
    // only its mouse-off tail; the 1049h comes from the helper, asserted above).
    const seq = rawEscapeWrites().find((s) => s.includes("[2J")) ?? ""
    expect(seq).toContain("[2J")
    expect(seq).toContain("[H")
    expect(seq).not.toContain("[3J")
  })

  it("takes the alternate screen only through the resolved gate, never a raw literal", () => {
    // No raw 1049 literal may live in this file: the sequences belong to
    // app-bootstrap (ALT_SCREEN_ENTER/LEAVE) and are only reachable through
    // enter/leaveAltScreen, so a future edit cannot half-wire a new path.
    expect(rawEscapeWrites().some((seq) => seq.includes("1049"))).toBe(false)
    // The gate itself: flag/env-resolved (default OFF — inline stays the
    // default because scrollback IS the transcript), and only on a TTY
    // (1049h into a pipe would corrupt piped output with an escape the reader
    // never asked for).
    expect(source).toContain("resolveAltScreen({ env: process.env })")
    expect(source).toContain("process.stdout.isTTY === true")
    expect(source).toContain("enterAltScreen(")
    // Every exit restores the main buffer: normal exit, crash, and kill. A
    // stuck alternate buffer leaves the shell staring at a frozen app screen.
    expect(source).toContain("leaveAltScreen(")
    expect(source).toContain('process.once("uncaughtException"')
    expect(source).toContain('process.once("unhandledRejection"')
    expect(source).toContain('process.once("SIGINT"')
    expect(source).toContain('process.once("SIGTERM"')
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

  it("carries exit-path restore scaffolding ONLY for the alt-screen buffer", () => {
    // Inline path restores nothing (its frame IS scrollback history). The
    // alt-screen path must restore the main buffer on every abnormal end, or
    // a crash/kill leaves the shell staring at a frozen app screen — hence
    // crash/kill handlers, but no generic process.on("exit") hook (it cannot
    // write reliably and would only add a second writer).
    expect(source).not.toContain('process.on("exit"')
    expect(source).toContain("leaveAltScreen(")
  })

  it("states what startup costs, so nobody is surprised by it later", () => {
    expect(source).toContain("Nothing above the frame is ever erased at startup")
  })

  it("still renders and attaches the resize guard", () => {
    expect(source).toContain("const instance = render(")
    expect(source).toContain("resizeGuard.attach(instance)")
    expect(source).toContain("export { NemoApp }")
  })
})
