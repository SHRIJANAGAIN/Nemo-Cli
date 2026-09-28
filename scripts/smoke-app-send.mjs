/* Full-App send E2E — "INPUT TYPE A MESSAGE ME KOI MESSAGE TYPE KRKR
 * SEND KARO NAHI JATA": the composer-only smoke (smoke-enter-ui.mjs) passes,
 * so this one renders the BUILT TrayambakApp itself (boot overlays, disabled
 * prop, global useAppInput, PromptInput wiring — every gate the standalone
 * smoke bypasses) on fake TTY stdin/stdout with TRAYAMBAK_DEBUG_INPUT=1 and
 * drives it exactly like a user:
 *
 *   boot → dismiss boot overlays (Esc x2) → type h,i,Enter → assert
 *     1. keystrokes reach Ink dispatch            (in= lines in input log)
 *     2. handleInput received the draft           (SUBMIT value="hi")
 *     3. the user message got counted             (footer "Tokens: N", N>0)
 *
 * Plus layout asserts for the resize report ("width both sides increases,
 * not towards the bottom"):
 *   4. frame must fill the viewport (root Box height="100%" is a no-op:
 *      Ink only ever setWidth(terminalWidth) on the root — ink.js:321 —
 *      so percentage height resolves against nothing and the border hugs
 *      content. On win32 a viewport-filling frame takes the
 *      clearTerminal path each frame (ink.js:100), so a fresh sink must
 *      contain ESC[2J after the fix.)
 *   5. a rows-only resize must grow the frame downward (40 → 50 rows)
 *   6. no single written line may exceed columns (a soft-wrapping line
 *      desyncs Ink's line-counted erase → stacked frames)
 *
 * Run: node scripts/smoke-app-send.mjs   (after npm run build)
 */
import { PassThrough } from "node:stream";
import { readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.TRAYAMBAK_DEBUG_INPUT = "1";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
// Isolate the debug log: a concurrent harness sharing %TEMP% can truncate
// trayambak-input.log mid-run and eat our lines (observed: our in="\r"
// vanished, replaced by a foreign entry seconds later).
process.env.TEMP = path.join(repo, ".smoke-tmp");
try {
  (await import("node:fs")).mkdirSync(process.env.TEMP, { recursive: true });
} catch { /* best effort */ }
process.env.TRAYAMBAK_LOGO_PATH = pathToFileURL(
  path.join(repo, "dist", "packages", "tui", "src", "ink-app-esm", "logo_ansi.txt"),
).href;

// Session hermeticity: a full-App boot creates real sessions in
// skt/8-conversations — without isolation, completed runs flip the next
// boot into the SessionPicker (no active session) and boot-state asserts
// flake. Same TRAYAMBAK_HOME sandbox as smoke-theme-switch; nothing touches
// real user sessions.
{
  const fsMem = await import("node:fs");
  const sandbox = fsMem.mkdtempSync(path.join(tmpdir(), "trayambak-send-"));
  const convDir = path.join(sandbox, "skt", "8-conversations");
  fsMem.mkdirSync(convDir, { recursive: true });
  fsMem.writeFileSync(path.join(sandbox, "package.json"), JSON.stringify({ name: "send-smoke" }));
  fsMem.writeFileSync(path.join(convDir, "sessions.json"), "[]");
  process.env.TRAYAMBAK_HOME = sandbox;
}

const logPath = path.join(tmpdir(), "trayambak-input.log");
try {
  unlinkSync(logPath);
} catch { /* first run */ }

process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error);
});
process.on("unhandledRejection", (error) => {
  console.error("[unhandledRejection]", error);
});

// ── Fake TTY ends (byte-identical to what a real terminal delivers) ────
const stdin = new PassThrough();
stdin.isTTY = true;
stdin.setRawMode = () => {};
stdin.ref = () => {};
stdin.unref = () => {};

const { createSanitizedStdin } = await import(
  pathToFileURL(path.join(repo, "dist", "packages", "tui", "src", "ink-app-esm", "stdin-sanitizer.js")).href
);
const sanitizedStdin = createSanitizedStdin(stdin);

const stdout = new PassThrough();
stdout.isTTY = true;
stdout.columns = 140; // wide enough for the 120-col logo + border + padding
stdout.rows = 40;
let sink = "";
stdout.on("data", (chunk) => {
  sink += chunk.toString();
});

const React = (await import("react")).default;
const { render } = await import("ink");
const { TrayambakApp } = await import(
  pathToFileURL(path.join(repo, "dist", "packages", "tui", "src", "ink-app-esm", "index.js")).href
);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readLog = () => {
  try {
    return readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
};
const stripAnsi = (text) =>
  text
    .replace(/\x1b\][0-9;]*[^\x07]*(\x07|\x1b\\)/g, "") // OSC
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""); // CSI

let failures = 0;
const tStart = Date.now();
function assert(cond, label, detail = "") {
  if (cond) {
    console.log("ok:", label);
  } else {
    failures += 1;
    console.error("FAIL:", label);
    if (detail) console.error(detail);
  }
}

/** Raw-write forensics for a layout checkpoint: line structure, clear-path
 *  presence, frame border counts (┌/└ rows ≈ frame height), and the exact
 *  tail bytes — enough to decode how frames joined without guessing. */
function sinkStats(label) {
  const stripped = stripAnsi(sink);
  const lines = stripped.split("\n");
  const tops = lines.filter((l) => l.startsWith("┌") || l.startsWith("╭")).length;
  const bots = lines.filter((l) => l.startsWith("└") || l.startsWith("╰")).length;
  console.error(
    `[dbg] ${label} t+${Date.now() - tStart}ms len=${sink.length} ` +
      `nl=${(sink.match(/\n/g) ?? []).length} has2J=${sink.includes("\x1b[2J")} ` +
      `tops=${tops} bots=${bots} tail=${JSON.stringify(sink.slice(-240))}`,
  );
}

/** Height of the frame written by the LAST clearTerminal: that write is a
 *  complete full-frame redraw, so its first ┌ → first following └ spans
 *  exactly the root Box height. Later clearless partial writes only append
 *  below that └, so they can't skew the measurement. */
function clearFrameHeight(raw) {
  const lines = stripAnsi(raw)
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const top = lines.findIndex((l) => l.startsWith("┌") || l.startsWith("╭"));
  if (top < 0) return -1;
  // First corner after the cap: the footer section's nested ╰──╯ starts
  // at col 1 (│╰…), never col 0, so it can't shadow the root's own ╰ cap
  // here — only the root bottom matches startsWith("╰").
  const bot = lines.findIndex(
    (l, i) => i > top && (l.startsWith("└") || l.startsWith("╰")),
  );
  return bot > top ? bot - top + 1 : -1;
}

// ── Boot: mirrors the real launcher (parent CLI always passes
//    TRAYAMBAK_CONFIG_JSON → themeName present → no boot ThemePicker) ───
const instance = render(
  React.createElement(TrayambakApp, {
    config: { themeName: "trayambak-dark" },
    modelName: "smoke-model",
    permissionMode: "ask",
  }),
  { stdin: sanitizedStdin, stdout },
);

await wait(1800); // boot effects: sessions, prompt files, agent profiles

// Boot-side mode asserts: App must hide the hardware caret and must NOT
// grab mouse reporting — the transcript's stable history lives in terminal
// scrollback (<Static>) and needs NATIVE wheel scroll + drag-select/copy;
// SGR 1000+1006 would swallow both (/copy is the keyboard path). Captured
// here because phase 1 resets `sink`.
const bootSink = sink;
assert(
  !bootSink.includes("\x1b[?1000h") && !bootSink.includes("\x1b[?1006h"),
  "mouse reporting stays OFF at boot (no ESC[?1000h / ESC[?1006h)",
  `--- boot sink tail ---\n${JSON.stringify(bootSink.slice(-300))}`,
);
assert(
  bootSink.includes("\x1b[?25l"),
  "hardware caret hidden at boot (ESC[?25l)",
  `--- boot sink tail ---\n${JSON.stringify(bootSink.slice(-300))}`,
);

// Dismiss boot overlays (SessionPicker auto-opens when sessions exist but
// none is active). On an overlay, Esc closes it; on the composer with an
// empty buffer, Esc is a harmless clear (PromptInput.tsx two-step clear).
stdin.write("\x1b");
await wait(350);
stdin.write("\x1b");
await wait(400);

// ── Phase 1: type like a user ──────────────────────────────────────────
sink = ""; // everything below must come from THIS interaction
let log = readLog();
const inboundBefore = (log.match(/ in=/g) || []).length;

stdin.write("h");
await wait(120);
stdin.write("i");
await wait(200);
stdin.write("\r");

// Poll for the SUBMIT line (logged at handleInput entry, App.tsx).
let submitSeen = false;
for (let i = 0; i < 15 && !submitSeen; i += 1) {
  await wait(200);
  log = readLog();
  submitSeen = log.includes('SUBMIT value="hi"');
}
await wait(600); // let the bubble + footer token count render

log = readLog();
const inbound = log.match(/ in=/g) || [];
const returnLine = /return=true/.test(log);

assert(
  inbound.length > inboundBefore && returnLine,
  `keystrokes reach Ink dispatch (in= ${inboundBefore} → ${inbound.length}, saw return=true)`,
  `--- input log tail ---\n${log.split("\n").slice(-12).join("\n")}`,
);
assert(
  submitSeen,
  `handleInput received draft (SUBMIT value="hi")`,
  `--- input log tail ---\n${log.split("\n").slice(-12).join("\n")}\n--- stripped sink tail ---\n${stripAnsi(sink).slice(-400)}`,
);
const stripped = stripAnsi(sink);
// Every frame prints the segment — the LAST match is the current footer
// (a first-match read sees the boot "Tokens: 0" forever).
const allTokens = [...stripped.matchAll(/Tokens:\s*(\d+)/g)];
const tokens = allTokens.length > 0 ? allTokens[allTokens.length - 1] : null;
assert(
  tokens !== null && Number(tokens[1]) > 0,
  `user message counted (footer ${tokens ? `Tokens: ${tokens[1]}` : "no Tokens segment"})`,
  `--- stripped sink tail ---\n${stripped.slice(-600)}`,
);
// The provider here is unreachable by design (bare config → localhost:8080)
// and the failure MUST be visible: the pre-fix path dropped the error emit
// (AggregateError has an empty .message) and the transcript stayed blank —
// "type hi, press Enter, nothing happens".
// NOTE: this polls (up to ~30s), it does NOT assert at a fixed delay — the
// error row can only render after the pre-turn checkpoint walk (up to its
// 15s budget in a big cwd), agent construction, and the failed connect.
// A fixed 600ms wait raced all of that and measured silence.
let modelErrSeen = false;
for (let i = 0; i < 60 && !modelErrSeen; i += 1) {
  await wait(500);
  modelErrSeen = stripAnsi(sink).includes("[model/connection error");
}
assert(
  modelErrSeen,
  "provider failure renders a visible error row (silent-send guard)",
  `--- stripped sink tail ---\n${stripAnsi(sink).slice(-600)}`,
);

// Event-loop stall guard: the pre-turn checkpoint snapshot used to run
// synchronously, freezing the app ~11.7s between SUBMIT and the global
// handler's next log line (the freeze that made send look broken).
// captureAsync must keep every gap between consecutive input-log lines tiny.
const stampMs = log
  .split("\n")
  .map((line) => Date.parse(line.slice(0, 24)))
  .filter((t) => Number.isFinite(t));
let maxGap = 0;
for (let i = 1; i < stampMs.length; i += 1) {
  maxGap = Math.max(maxGap, stampMs[i] - stampMs[i - 1]);
}
assert(
  stampMs.length > 4 && maxGap < 2500,
  `no event-loop stall during send (max input-log gap ${maxGap}ms < 2500ms)`,
);
console.error(`[dbg] log after phase1 ---\n${readLog()}`);

// ── Phase 2: layout — frame must fill viewport and follow rows ────────
await wait(400);
sink = ""; // fresh sink: only current-width frames
// An idle app renders NOTHING on its own (no pending state changes), and
// with a provider-less config the turn ends within ~150ms — so the old
// "wait and frames will come" probe was racing the turn and measured
// silence when it lost. Poke the app the way a user does — one keystroke
// plus backspace (draft left exactly as before) — and measure THAT frame.
stdin.write("x");
await wait(200);
stdin.write("\x7f");
await wait(600);

sinkStats("L1 pre-resize (rows=40, expect fullscreen frame with ESC[2J)");
assert(
  sink.includes("\x1b[2J"),
  "frame fills viewport (win32 fullscreen clear present)",
  `root Box height="100%" never resolves — Ink only setWidth()s the root (ink.js:321); ` +
    `frame hugs content instead of reaching the terminal bottom. sink has no ESC[2J.`,
);
const clearIdxL1 = sink.lastIndexOf("\x1b[2J");
const h1 = clearFrameHeight(sink.slice(clearIdxL1));
assert(
  h1 >= 39 && h1 <= 41,
  `pre-resize frame height matches rows=40 (clear frame spans ${h1} lines)`,
);

stdout.rows = 50;
stdout.emit("resize");
await wait(900);

sinkStats("L2 post-resize (rows=50, expect taller fullscreen frame)");
const clearIdx = sink.lastIndexOf("\x1b[2J");
const h2 = clearIdx >= 0 ? clearFrameHeight(sink.slice(clearIdx)) : -1;
assert(
  h2 >= 48 && h2 <= 52,
  `rows-resize grows frame downward (clear frame spans ${h2} lines, expect ≈50)`,
);

// Width check, with frame-join artifacts decoded (root cause): fullscreen
// frames omit the trailing \n, and ink re-emits the last frame via
// restoreLastOutput() after every external write (patched console →
// writeToStdout/writeToStderr: log.clear() + data + restore frame). For
// console.error the data lands on stderr — invisible to this stdout sink —
// leaving only positioning CSI between the old frame's `┘` and the redraw's
// `┌`; stripAnsi erases that CSI and fuses two 140-col borders into one
// bogus 280-col "line" (the real terminal is fine: log.clear positions and
// erases first). So split rows where content meets positioning/mode CSI
// (and at sync markers / clearTerminal) before measuring width.
const wide = sink
  .split("\x1b[2J")
  .flatMap((segment) =>
    stripAnsi(
      segment
        .replace(/\x1b\[\?2026[lh]/g, "\n")
        .replace(/([^\n])\x1b(?:\[[0-9;]*[ABCDEFGHJKSTfs]|\[\?[0-9;]*[hl])/g, "$1\n"),
    ).split("\n"),
  )
  .filter((line) => line.length > stdout.columns);
sinkStats("L3 width check");
assert(
  wide.length === 0,
  `no written line exceeds columns=${stdout.columns}`,
  wide.length > 0 ? `widest offender (${wide[0].length} cols) full line: ${JSON.stringify(wide[0].slice(0, 400))}` : "",
);

console.error(`[dbg] log before unmount ---\n${readLog()}`);
instance.unmount();
await wait(80); // PassThrough delivers 'data' on the next tick
assert(
  sink.includes("\x1b[?1000l") && sink.includes("\x1b[?1006l") && sink.includes("\x1b[?25h"),
  "mouse + caret restored on unmount (ESC[?1000l + ESC[?1006l + ESC[?25h)",
  `--- sink tail ---\n${JSON.stringify(sink.slice(-300))}`,
);
console.error(`[dbg] log after unmount ---\n${readLog()}`);

console.log(failures === 0 ? "APP_SEND_SMOKE_OK" : `APP_SEND_SMOKE_FAIL ${failures}`);
process.exit(failures === 0 ? 0 : 1);
