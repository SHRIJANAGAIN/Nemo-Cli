// Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
// Trayambak CLI Proprietary License - use, copying, modification, and
// distribution require a written license agreement with SKT AI LABS
// PRIVATE LIMITED. See LICENSE for the full terms.
// /

import { render } from "ink"
import { createElement } from "react"
import { fileURLToPath } from "node:url"
import path from "node:path"
import fs from "node:fs"
import { TrayambakApp } from "../ink-app-esm/index.js"
import { createSanitizedStdin } from "../ink-app-esm/stdin-sanitizer.js"
import { createResizeRedrawGuard } from "../ink-app-esm/resize-guard.js"
// keymap compiles to CJS (root package.json type=commonjs), and the flat
// ink-app-esm/ dir carries its own {type:"module"} marker — importing the
// CJS text that lives THERE fails the ESM static link ("does not provide an
// export named 'setKeymap'"). The parent copy is commonjs-scope, so Node's
// CJS→ESM lexer resolves the named exports (verified against the obfuscated
// publish build too), and App.js already imports this same ../keymap.js —
// one module instance, one shared active Keymap.
import { setKeymap } from "../keymap.js"

const here = path.dirname(fileURLToPath(import.meta.url))

function loadConfig() {
  const raw = process.env.TRAYAMBAK_CONFIG_JSON
  if (raw) {
    try {
      return JSON.parse(raw)
    } catch {}
  }
  return {}
}

function loadPrompt() {
  const raw = process.env.TRAYAMBAK_PROMPT
  return raw || undefined
}

const config = loadConfig()
const prompt = loadPrompt()
setKeymap(config.keybindings)
process.env.TRAYAMBAK_LOGO_PATH =
  process.env.TRAYAMBAK_LOGO_PATH || path.join(here, "..", "ink-app-esm", "logo_ansi.txt")

// The parent CLI must not consume or pause the inherited console handle.
// Only disable raw mode if the stdin supports it and is currently in raw mode.
// Ink will set raw mode to true itself; we just need to ensure a clean starting state.
if (process.stdin.isTTY && process.stdin.setRawMode && process.stdin.isRaw) {
  process.stdin.setRawMode(false)
}

const renderOptions = {
  // Route raw stdin through the sanitizer before Ink parses it. It normalises
  // exotic Enter byte-shapes (kitty kpenter \x1b[57414u, SS3 \x1bOM) to a
  // plain CR and owns bracketed-paste pairing — an unpaired paste-start
  // marker would otherwise park ALL input in Ink's parser forever, so the
  // draft stays visible but Enter never submits ("message in the box, press
  // Enter, nothing sent"). The import below existed but was never used;
  // this is the missing wire (the smoke test only passed because it wires
  // createSanitizedStdin itself).
  stdin: createSanitizedStdin(process.stdin),
  stdout: process.stdout,
  // Ctrl-C belongs to Trayambak, not Ink: Ink's default exitOnCtrlC exits
  // the whole TUI on a single press (before our handlers run), which made
  // accidental session death unavoidable. Disabled here; PromptInput routes
  // empty-composer Ctrl-C to App (deny dialog / abort turn / arm-exit
  // double press) and clears drafts otherwise.
  exitOnCtrlC: false,
}

// If stdin is not a TTY, Ink cannot use raw mode. Pass stdin: undefined so ink
// falls back to a non-interactive render (no useInput). The UI still renders.
if (!process.stdin.isTTY) {
  renderOptions.stdin = undefined
}

// Resume AFTER createSanitizedStdin attached its data listener (attaching a
// listener resumes the stream too). Resuming first opened a byte-loss window
// during module init: keystrokes delivered before the sanitizer's listener
// existed were dropped on the floor.
process.stdin.resume()

// Register our 'resize' listener BEFORE render(): EventEmitter calls
// listeners in registration order, so this guard runs ahead of Ink's own
// `resized` handler. Width changes re-flow the frame already on screen
// (full-width border rows split into two rows at a narrower width), which
// leaves Ink's line-count-based eraseLines() counting stale rows — each
// render then misses part of the old frame and frames pile up in
// scrollback with drifting indents. The guard blanks the viewport and
// resets Ink's counters first, so its ensuing re-render repaints cleanly
// from (0,0). See resize-guard.ts for the full write-up.
const resizeGuard = createResizeRedrawGuard(process.stdout)

// TRAYAMBAK_TRACE=1: tee every stdout byte into trayambak-trace.log (cwd).
// The stuck-header report ("text frozen beside the TRAYAMBAK logo") has never
// reproduced under the screen-replay harness — every fullscreen frame is a
// clean full clear+rewrite across all tested paths — so the next real-world
// repro needs ground truth. Raw bytes only (replayable through
// scripts/vt-screen.mjs), capped at 20MB, and failures never break the UI.
if (process.env.TRAYAMBAK_TRACE === "1") {
  try {
    const tracePath = path.resolve(process.cwd(), "trayambak-trace.log")
    const fd = fs.openSync(tracePath, "w")
    const LIMIT = 20 * 1024 * 1024
    let written = 0
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk, encoding, cb) => {
      if (written < LIMIT) {
        const buf = Buffer.isBuffer(chunk)
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk)
            : Buffer.from(String(chunk), typeof encoding === "string" ? encoding : "utf8")
        const take = Math.min(buf.length, LIMIT - written)
        if (take > 0) {
          try {
            fs.writeSync(fd, buf.subarray(0, take))
            written += take
          } catch {
            /* tracing must never break the UI */
          }
        }
      }
      return origWrite(chunk, encoding, cb)
    }
    process.stderr.write(`[trayambak] stdout trace ON → ${tracePath}\n`)
  } catch (err) {
    process.stderr.write(`[trayambak] trace failed to start: ${err?.message ?? err}\n`)
  }
}

// Clear the terminal ONCE, before the renderer exists, so the host shell's
// banner and prompt are not the first thing on screen — and, with ED3, are not
// sitting at the bottom of the scrollback either.
//
//   2J  erase the viewport
//   3J  erase the SCROLLBACK, which is what actually removes the banner: with
//       2J alone it survives and reappears on the first scroll up. Terminals
//       that do not implement ED3 ignore it and simply keep the banner.
//   H   home the cursor
//
// This is a ONE-TIME startup clear, which is what makes the three requirements
// compatible. It runs before the first render, so the renderer has no frame
// bookkeeping to desynchronise, and nothing clears the scrollback again
// afterwards:
//
//   - Repaints never erase scrollback. The renderer's flicker recovery used to
//     wipe it on every window resize (`clearTerminal.ts` emitted ED3), deleting
//     the transcript the UI had already printed; that path is screen-only now.
//   - The alternate screen is NOT used. It hides the banner too, but its buffer
//     has no scrollback at all, so the rows the UI settles into <Static> become
//     unreachable and the history cannot be scrolled.
//
// Cost, stated plainly: the shell's pre-launch scrollback is erased along with
// the banner. That is the only thing lost, and it is what "no banner" requires.
//
//   ?1000l ?1002l ?1003l ?1006l ?1015l
//       turn OFF every mouse-reporting mode. This is what makes the DEVICE's
//       own scrollbar and wheel the way history is read. The UI deliberately
//       has no in-app scroll window: history is the terminal's, printed once
//       through Ink's <Static>, and the frame always ends at the live tail.
//       While ANY reporting mode is on, the terminal routes wheel and drag
//       events to the app instead of scrolling its own buffer, so the
//       scrollbar stops working and the transcript looks frozen. The app never
//       enables reporting (`renderOptions` carries no mouse option), so a mode
//       can only be left over from a run that was killed mid-flight;
//       `mouse-input.ts` documents exactly this symptom (wheel bytes that
//       "never should arrive" while reporting is off). Clearing it here is
//       idempotent and costs nothing when nothing is set.
//
// Cursor visibility is untouched — the caret stays visible for the composer.
if (process.stdout.isTTY === true) {
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l")
}

const instance = render(
  createElement(TrayambakApp, {
    config: config,
    modelName: config.model ?? "trayambak Fable 5",
    permissionMode: "ask",
    onExit: () => {
      process.exit(0)
    },
    initialPrompt: prompt,
  }),
  renderOptions,
)
resizeGuard.attach(instance)

export { TrayambakApp }
