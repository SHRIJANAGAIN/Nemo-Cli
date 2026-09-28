/* Contract test for the startup-screen pile-up fix (resize-guard.ts).
 *
 * Bug: Ink erases its previous frame by cursor-up x split('\n').length — a
 * LINE count. A terminal width change re-flows the rows already on screen
 * (the frame's full-width border rows split in two at a narrower width),
 * so that count goes stale and every re-render misses rows → old frames
 * accumulate in scrollback with drifting indents (stacked logos).
 *
 * The guard (registered BEFORE Ink's own resize listener, so it runs first)
 * must, on a width change only:
 *   1. blank the viewport + home the cursor (ESC[2J ESC[H);
 *   2. reset Ink's line bookkeeping (log.reset + lastOutput = '');
 * and Ink must then repaint the full frame from (0,0) — exactly one live
 * frame, no reliance on the stale erase.
 *
 * Height-only resizes must NOT blank (no re-flow happens; blanking there
 * would just flicker).
 *
 * Run: node scripts/smoke-resize-guard.mjs
 */
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (...parts) =>
  pathToFileURL(path.join(here, "..", "dist", "packages", "tui", "src", "ink-app-esm", ...parts)).href;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stripAnsi = (text) =>
  text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[=>]/g, "");

const BLANK = "\x1b[2J\x1b[H";
const WELCOME = "Welcome To Trayambak CLI";

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "ok" : "FAIL"}: ${label}`);
  if (!ok) failures++;
};

// ── Fake TTY ────────────────────────────────────────────────────────────
const stdin = new PassThrough();
stdin.isTTY = true;
stdin.setRawMode = () => {};
stdin.ref = () => {};
stdin.unref = () => {};

const stdout = new PassThrough();
stdout.isTTY = true;
stdout.columns = 219;
stdout.rows = 40;
let sink = "";
stdout.on("data", (chunk) => {
  sink += chunk.toString();
});

const React = (await import("react")).default;
const { render } = await import("ink");
const { TrayambakApp } = await import(dist("index.js"));
const { createResizeRedrawGuard } = await import(dist("resize-guard.js"));

// Same wiring as ink-repl.mjs: guard listener registered BEFORE render()
// (so it precedes Ink's own 'resize' handler), instance attached after.
const resizeGuard = createResizeRedrawGuard(stdout);
const instance = render(
  React.createElement(TrayambakApp, {
    config: { themeName: "trayambak-dark", baseUrl: "http://localhost:1", apiKey: "x" },
  }),
  { stdin, stdout, patchConsole: false },
);
resizeGuard.attach(instance);
await wait(500);

// ── 1. Width DEcrease: must blank + full repaint ───────────────────────
let mark = sink.length;
stdout.columns = 150;
stdout.emit("resize");
await wait(300);
let post = sink.slice(mark);
let blankAt = post.indexOf(BLANK);
check(blankAt !== -1, "width decrease → viewport blanked (ESC[2J ESC[H)");
if (blankAt !== -1) {
  const repaint = post.slice(blankAt + BLANK.length);
  check(
    stripAnsi(repaint).includes(WELCOME),
    "width decrease → full frame repainted after the blank (no stale-erase reliance)",
  );
  const welcomes = (stripAnsi(post).match(new RegExp(WELCOME, "g")) ?? []).length;
  check(welcomes === 1, `width decrease → exactly one live frame written (got ${welcomes})`);
}

// ── 2. Width INcrease: Ink never clears on this path itself → guard must ──
mark = sink.length;
stdout.columns = 240;
stdout.emit("resize");
await wait(300);
post = sink.slice(mark);
blankAt = post.indexOf(BLANK);
check(blankAt !== -1, "width increase → viewport blanked (Ink's own handler never does this)");
if (blankAt !== -1) {
  const repaint = post.slice(blankAt + BLANK.length);
  check(
    stripAnsi(repaint).includes(WELCOME),
    "width increase → full frame repainted after the blank",
  );
}

// ── 3. Height-only resize: must NOT blank (no re-flow → no desync) ─────
mark = sink.length;
stdout.rows = 35;
stdout.emit("resize");
await wait(300);
post = sink.slice(mark);
check(!post.includes(BLANK), "height-only resize → no blank (avoids needless flicker)");

// ── 4. Subsequent renders still work (counters not left broken) ────────
mark = sink.length;
instance.rerender(
  React.createElement(TrayambakApp, {
    config: { themeName: "trayambak-dark", baseUrl: "http://localhost:1", apiKey: "x" },
  }),
);
await wait(300);
post = stripAnsi(sink.slice(mark));
check(
  post.length === 0 || post.includes(WELCOME) || post.includes("TRAYAMBAK"),
  "post-resize re-render still emits a coherent frame",
);

instance.unmount();
await wait(50);

console.log(failures === 0 ? "RESIZE_GUARD_SMOKE_OK" : `RESIZE_GUARD_SMOKE_FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
