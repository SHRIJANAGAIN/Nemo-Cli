/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * End-to-end proof that the terminal title actually reaches a terminal.
 *
 * Unit tests assert the title *strings*; this asserts the *bytes* leave the
 * process as a real OSC 0 sequence on a real TTY. It runs the shipped
 * module's writer under a pty (node-pty is not a dependency, so the pty is
 * provided by spawning the CLI under a pseudo-terminal via `script`), which is
 * why this lives behind a file-level skip when no pty is obtainable: the
 * escape-sequence assertions must not silently become no-ops on CI.
 */

import { afterEach, describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import { buildAnimatedTitle, buildTerminalTitle } from "./terminal-notify.js"

/** OSC 0 (set title + icon), BEL-terminated — what we emit. */
const OSC0 = /\x1b\]0;([^\x07\x1b]*)\x07/

function hasPty(): boolean {
  if (process.platform === "win32") {
    // No pty is available on Windows without extra tooling; the byte-level
    // assertions below are therefore Unix-only and skipped here rather than
    // faked. The title strings themselves are covered by the other tests.
    return false
  }
  try {
    const probe = spawnSync("script", ["-qec", "true", "/dev/null"], { timeout: 5000 })
    return probe.status === 0
  } catch {
    return false
  }
}

const PTY_AVAILABLE = hasPty()

describe.skipIf(!PTY_AVAILABLE)("terminal title over a real pty", () => {
  let captured = ""

  afterEach(() => {
    captured = ""
    try {
      fs.rmSync(path.join(os.tmpdir(), "trayambak-title-pty"), { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  it("emits OSC 0 with the product name when the app claims the title", () => {
    const script = path.join(os.tmpdir(), "trayambak-title-emit.mjs")
    fs.writeFileSync(
      script,
      [
        "import { setTerminalTitle, buildTerminalTitle, startTitleAnimation, stopTitleAnimation } from " +
          JSON.stringify(new URL("./terminal-notify.js", import.meta.url).href),
        'setTerminalTitle(buildTerminalTitle({ activity: "idle" }))',
        "startTitleAnimation({ backgroundCount: 2 })",
        'stopTitleAnimation(buildTerminalTitle({ activity: "idle" }))',
      ].join("\n"),
      "utf8",
    )
    const out = spawnSync("script", ["-qec", `node ${script}`, "/dev/null"], { timeout: 20_000 })
    captured = String(out.stdout ?? "")
    expect(OSC0.test(captured)).toBe(true)
    expect(captured).toContain("Trayambak")
  })
})

describe("title byte contract", () => {
  it("keeps every emitted title free of ESC/BEL so no nesting or injection is possible", () => {
    // The title is interpolated into an OSC 0 payload; a BEL or ESC inside it
    // would terminate the sequence early and spill raw bytes into the terminal.
    const titles = [
      buildTerminalTitle({ activity: "idle" }),
      buildTerminalTitle({ activity: "working", backgroundCount: 3 }),
      buildAnimatedTitle("|", { backgroundCount: 2, phase: "thinking" }),
    ]
    for (const title of titles) {
      expect(title).not.toMatch(/[\x00-\x1F\x7F]/)
    }
  })
})
