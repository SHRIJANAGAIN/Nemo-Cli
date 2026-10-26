// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0

import { render } from "ink"
import { createElement } from "react"
import { fileURLToPath } from "node:url"
import path from "node:path"
import fs from "node:fs"
import { NemoApp } from "../ink-app-esm/index.js"
import { createSanitizedStdin } from "../ink-app-esm/stdin-sanitizer.js"
import { createResizeRedrawGuard } from "../ink-app-esm/resize-guard.js"
import { enterAltScreen, leaveAltScreen, resolveAltScreen } from "../ink-app-esm/app-bootstrap.js"
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
  const raw = process.env.NEMO_CONFIG_JSON
  if (raw) {
    try {
      return JSON.parse(raw)
    } catch {}
  }
  return {}
}

function loadPrompt() {
  const raw = process.env.NEMO_PROMPT
  return raw || undefined
}

const config = loadConfig()
const prompt = loadPrompt()
setKeymap(config.keybindings)
process.env.NEMO_LOGO_PATH =
  process.env.NEMO_LOGO_PATH || path.join(here, "..", "ink-app-esm", "logo_ansi.txt")

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
  // Ctrl-C belongs to Nemo, not Ink: Ink's default exitOnCtrlC exits
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

// NEMO_TRACE=1: tee every stdout byte into nemo-trace.log (cwd).
// The stuck-header report ("text frozen beside the NEMO logo") has never
// reproduced under the screen-replay harness — every fullscreen frame is a
// clean full clear+rewrite across all tested paths — so the next real-world
// repro needs ground truth. Raw bytes only (replayable through
// scripts/vt-screen.mjs), capped at 20MB, and failures never break the UI.
if (process.env.NEMO_TRACE === "1") {
  try {
    const tracePath = path.resolve(process.cwd(), "nemo-trace.log")
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
    process.stderr.write(`[nemo] stdout trace ON → ${tracePath}\n`)
  } catch (err) {
    process.stderr.write(`[nemo] trace failed to start: ${err?.message ?? err}\n`)
  }
}

// Alternate screen (codex-style --alt-screen / NEMO_ALT_SCREEN): the
// whole TUI runs on the terminal's alternate buffer, which HAS no scrollback
// — resizes, over-height paints and stale erases can only ever disturb the
// live viewport, so clones are structurally impossible there. That is the
// entire reason codex never clones, and it is why this is now the DEFAULT
// path: scripts/diag-boot-clone.mjs reproduces the inline shrink clone
// (37 stray rows into scrollback) and shows the same run clean under
// ?1049h. The price is paid by the default path too: with no scrollback the
// device scrollbar and wheel go dead and history that leaves the frame
// cannot be scrolled back to. --no-alt-screen / NEMO_ALT_SCREEN=0
// restores inline mode (terminal scrollback, clones included) explicitly.
const useAltScreen = resolveAltScreen({ env: process.env })
const altScreenActive = useAltScreen && process.stdout.isTTY === true
if (altScreenActive) {
  // Any abnormal end must restore the main buffer first, or the shell is left
  // staring at a frozen app screen. Normal exit goes through onExit below;
  // these cover crash/kill paths (no-ops unless we actually entered).
  const leaveAndExit = (code) => {
    try {
      leaveAltScreen(process.stdout.write.bind(process.stdout))
    } catch {}
    process.exit(code)
  }
  process.once("uncaughtException", (err) => {
    try {
      process.stderr.write(`${err?.stack ?? err}\n`)
    } catch {}
    leaveAndExit(1)
  })
  process.once("unhandledRejection", (reason) => {
    try {
      process.stderr.write(`${reason}\n`)
    } catch {}
    leaveAndExit(1)
  })
  process.once("SIGINT", () => leaveAndExit(130))
  process.once("SIGTERM", () => leaveAndExit(143))
}

// Clear the terminal ONCE, before the renderer exists, so the host shell's
// banner and prompt are not the first thing on screen. This is the INLINE
// path's clear (the explicit --no-alt-screen opt-out); the default alternate-screen
// path opens a fresh blank buffer instead and skips all of this.
//
//   2J  erase the viewport
//   H   home the cursor
//
// ED3 (erase scrollback) is deliberately NOT sent: the scrollback IS the
// transcript, so the banner, the prompt and earlier sessions stay intact
// above the app. Nothing above the frame is ever erased at startup.
//
// This is a ONE-TIME startup clear, which is what makes the three requirements
// compatible. It runs before the first render, so the renderer has no frame
// bookkeeping to desynchronise, and nothing clears the scrollback again
// afterwards:
//
//   - Repaints never erase scrollback. The renderer's flicker recovery used to
//     wipe it on every window resize (`clearTerminal.ts` emitted ED3), deleting
//     the transcript the UI had already printed; that path is screen-only now.
//   - The alternate screen is now the DEFAULT. It hides the banner too, but
//     its buffer has no scrollback at all, so the rows the UI settles into
//     <Static> cannot be scrolled back to once they leave the frame — the
//     price paid for frames that reflow can never duplicate. --no-alt-screen
//     / NEMO_ALT_SCREEN=0 runs this inline path instead: real terminal
//     scrollback, and the reflow clones it can strand (diag-boot-clone
//     reproduces both sides).
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
  if (altScreenActive) {
    // Fresh blank buffer: no banner to clear, no scrollback to nuke (there is
    // none). Still switch off stale mouse-reporting modes — those survive
    // from killed runs and would eat the wheel either way.
    enterAltScreen(process.stdout.write.bind(process.stdout))
    process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l")
  } else {
    process.stdout.write("\x1b[2J\x1b[H\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l")
  }
}

const instance = render(
  createElement(NemoApp, {
    config: config,
    modelName: config.model ?? "nemo Fable 5",
    permissionMode: "ask",
    onExit: () => {
      // process.exit skips React's unmount cleanup, so restore the main
      // buffer (+ caret) first when alt-screen is active. Inline mode needs
      // nothing: its frame IS scrollback history.
      if (altScreenActive) {
        try {
          leaveAltScreen(process.stdout.write.bind(process.stdout))
        } catch {}
      }
      process.exit(0)
    },
    initialPrompt: prompt,
  }),
  renderOptions,
)
resizeGuard.attach(instance)

export { NemoApp }
