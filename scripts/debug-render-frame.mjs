/* Root-cause probe for the startup-screen pile-up bug (frames stacking in
 * scrollback with shifting widths instead of redrawing in place).
 *
 * Ink's interactive renderer erases exactly `split('\n').length` rows before
 * rewriting (log-update.js). That accounting breaks when:
 *   1. any rendered row is WIDER than stdout.columns → the terminal hard-wraps
 *      it into 2 screen rows ink doesn't know about → eraseLines() under-erases
 *      → every render leaves stale rows behind (the screenshot's stacked logos);
 *   2. the frame is taller than stdout.rows → fullscreen path → full clear
 *      (handled on win32), but worth measuring;
 *   3. resize reflows old frames differently than ink remembers them.
 *
 * This harness renders the REAL TrayambakApp at a fake TTY, forces several
 * re-renders (resize events), then reports:
 *   - max visible row width vs columns (any offender printed verbatim)
 *   - how many "Welcome To Trayambak CLI" lines survive in the sink
 *     (must be 1 per live frame region — >1 proves pile-up)
 *   - frame height vs rows.
 *
 * Run: node scripts/debug-render-frame.mjs [columns] [rows]
 */
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const columns = Number(process.argv[2] ?? 219);
const rows = Number(process.argv[3] ?? 40);

const stdin = new PassThrough();
stdin.isTTY = true;
stdin.setRawMode = () => {};
stdin.ref = () => {};
stdin.unref = () => {};

const stdout = new PassThrough();
stdout.isTTY = true;
stdout.columns = columns;
stdout.rows = rows;
let sink = "";
stdout.on("data", (chunk) => {
  sink += chunk.toString();
});

const React = (await import("react")).default;
const { render } = await import("ink");
const { TrayambakApp } = await import(
  pathToFileURL(
    path.join(here, "..", "dist", "packages", "tui", "src", "ink-app-esm", "index.js"),
  ).href
);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stripAnsi = (text) =>
  text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[=>]/g, "");

// themeName set → skip the first-run ThemePicker and render the actual
// WelcomeScreen (the frame the bug report screenshot shows).
const instance = render(
  React.createElement(TrayambakApp, {
    config: { themeName: "trayambak-dark", baseUrl: "http://localhost:1", apiKey: "x" },
  }),
  {
    stdin,
    stdout,
  },
);
await wait(400);

// Force several re-renders the way a window drag would: ink's resized()
// handler recalculates layout + re-emits the frame on each event.
const frames = [];
for (let i = 0; i < 5; i++) {
  const mark = sink.length;
  stdout.emit("resize");
  await wait(120);
  frames.push(sink.slice(mark));
}

instance.unmount();
await wait(50);

// ── Analysis ───────────────────────────────────────────────────────────
const all = stripAnsi(sink);
const lines = all.split("\n");
let maxW = 0;
const offenders = [];
for (const line of lines) {
  if (line.length > maxW) maxW = line.length;
  if (line.length > columns && offenders.length < 10) offenders.push(line);
}

// eraseLines() bookkeeping: count frame writes (welcome marker occurrences)
// vs the number of full clear sequences ([2J or [3J) that would reset ink's
// line counter.
const welcomeCount = (all.match(/Welcome To Trayambak CLI/g) ?? []).length;
const clearCount = (sink.match(/\x1b\[2J|\x1b\[3J/g) ?? []).length;
const eraseUpSequences = (sink.match(/\x1b\[2K\x1b\[1A/g) ?? []).length;

const resizeFrameWelcomes = frames.map(
  (f) => (stripAnsi(f).match(/Welcome To Trayambak CLI/g) ?? []).length,
);

console.log(`columns=${columns} rows=${rows}`);
console.log(`maxVisibleRowWidth=${maxW} ${maxW > columns ? "EXCEEDS_COLUMNS ✗" : "ok ✓"}`);
if (offenders.length) {
  console.log("--- rows wider than terminal (each one desyncs ink's erase count) ---");
  for (const line of offenders) console.log(`[${line.length}] ${JSON.stringify(line)}`);
}
console.log(`welcomeMarkerTotal=${welcomeCount} (5 forced re-renders + initial)`);
console.log(`welcomePerForcedRender=${JSON.stringify(resizeFrameWelcomes)}`);
console.log(`clearScreenSequences=${clearCount} eraseUpRuns=${eraseUpSequences}`);
console.log("--- tail of final stripped frame (40 lines) ---");
console.log(lines.slice(-40).join("\n"));
process.exit(0);
