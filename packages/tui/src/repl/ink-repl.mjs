// Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
// Trayambak CLI Proprietary License - use, copying, modification, and
// distribution require a written license agreement with SKT AI LABS
// PRIVATE LIMITED. See LICENSE for the full terms.
// /

import { render } from "ink";
import { createElement } from "react";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { TrayambakApp } from "../ink-app-esm/index.js";
import { createSanitizedStdin } from "../ink-app-esm/stdin-sanitizer.js";
import { createResizeRedrawGuard } from "../ink-app-esm/resize-guard.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const raw = process.env.TRAYAMBAK_CONFIG_JSON;
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {}
  }
  return {};
}

function loadPrompt() {
  const raw = process.env.TRAYAMBAK_PROMPT;
  return raw || undefined;
}

const config = loadConfig();
const prompt = loadPrompt();
process.env.TRAYAMBAK_LOGO_PATH = process.env.TRAYAMBAK_LOGO_PATH
  || path.join(here, "..", "ink-app-esm", "logo_ansi.txt");

// The parent CLI must not consume or pause the inherited console handle.
// Only disable raw mode if the stdin supports it and is currently in raw mode.
// Ink will set raw mode to true itself; we just need to ensure a clean starting state.
if (process.stdin.isTTY && process.stdin.setRawMode && process.stdin.isRaw) {
  process.stdin.setRawMode(false);
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
};

// If stdin is not a TTY, Ink cannot use raw mode. Pass stdin: undefined so ink
// falls back to a non-interactive render (no useInput). The UI still renders.
if (!process.stdin.isTTY) {
  renderOptions.stdin = undefined;
}

// Resume AFTER createSanitizedStdin attached its data listener (attaching a
// listener resumes the stream too). Resuming first opened a byte-loss window
// during module init: keystrokes delivered before the sanitizer's listener
// existed were dropped on the floor.
process.stdin.resume();

// Register our 'resize' listener BEFORE render(): EventEmitter calls
// listeners in registration order, so this guard runs ahead of Ink's own
// `resized` handler. Width changes re-flow the frame already on screen
// (full-width border rows split into two rows at a narrower width), which
// leaves Ink's line-count-based eraseLines() counting stale rows — each
// render then misses part of the old frame and frames pile up in
// scrollback with drifting indents. The guard blanks the viewport and
// resets Ink's counters first, so its ensuing re-render repaints cleanly
// from (0,0). See resize-guard.ts for the full write-up.
const resizeGuard = createResizeRedrawGuard(process.stdout);

// TRAYAMBAK_TRACE=1: tee every stdout byte into trayambak-trace.log (cwd).
// The stuck-header report ("text frozen beside the TRAYAMBAK logo") has never
// reproduced under the screen-replay harness — every fullscreen frame is a
// clean full clear+rewrite across all tested paths — so the next real-world
// repro needs ground truth. Raw bytes only (replayable through
// scripts/vt-screen.mjs), capped at 20MB, and failures never break the UI.
if (process.env.TRAYAMBAK_TRACE === "1") {
  try {
    const tracePath = path.resolve(process.cwd(), "trayambak-trace.log");
    const fd = fs.openSync(tracePath, "w");
    const LIMIT = 20 * 1024 * 1024;
    let written = 0;
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, encoding, cb) => {
      if (written < LIMIT) {
        const buf = Buffer.isBuffer(chunk)
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk)
            : Buffer.from(String(chunk), typeof encoding === "string" ? encoding : "utf8");
        const take = Math.min(buf.length, LIMIT - written);
        if (take > 0) {
          try { fs.writeSync(fd, buf.subarray(0, take)); written += take; } catch { /* tracing must never break the UI */ }
        }
      }
      return origWrite(chunk, encoding, cb);
    };
    process.stderr.write(`[trayambak] stdout trace ON → ${tracePath}\n`);
  } catch (err) {
    process.stderr.write(`[trayambak] trace failed to start: ${err?.message ?? err}\n`);
  }
}

const instance = render(
  createElement(TrayambakApp, {
    config: config,
    modelName: config.model ?? "trayambak Fable 5",
    permissionMode: "ask",
    onExit: () => {
      process.exit(0);
    },
    initialPrompt: prompt,
  }),
  renderOptions,
);
resizeGuard.attach(instance);

export { TrayambakApp };
