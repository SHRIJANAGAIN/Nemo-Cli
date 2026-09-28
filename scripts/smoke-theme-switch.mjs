/* Theme-switch repaint smoke: boots the REAL TrayambakApp (dist) in a
 * sandbox, runs `/theme night-sky`, and asserts the frame actually repaints
 * in the new palette. Guards the subscription fix (useSyncExternalStore):
 * before it, setThemeByName() mutated a module global with no re-render,
 * so the "Theme switched" message posted while every color stayed stale.
 *
 * night-sky primary  #82aaff → ANSI 38;2;130;170;255 must appear in frames
 * written AFTER the switch (trayambak-dark primary is 108;182;245).
 * Also asserts the /themes marker tracks the LIVE theme, not boot config.
 *
 * FORCE_COLOR=3 is set BEFORE ink/chalk load: on a piped stdout chalk's
 * level is 0, so theme (chalk-derived) colors emit no bytes at all — only
 * the logo's embedded ANSI would show, and no repaint could ever be
 * asserted (same trap as tool-call-pulse.test.ts).
 *
 * Run: node scripts/smoke-theme-switch.mjs
 */
process.env.FORCE_COLOR = "3";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const distEsm = pathToFileURL(path.join(repo, "dist", "packages", "tui", "src", "ink-app-esm")).href;

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-theme-"));
fs.mkdirSync(path.join(sandbox, "skt", "8-conversations"), { recursive: true });
fs.writeFileSync(path.join(sandbox, "package.json"), JSON.stringify({ name: "theme-smoke" }));
process.env.TRAYAMBAK_HOME = sandbox;

const stdin = new PassThrough();
stdin.isTTY = true;
stdin.setRawMode = () => {};
stdin.ref = () => {};
stdin.unref = () => {};

const stdout = new PassThrough();
stdout.isTTY = true;
stdout.columns = 140;
stdout.rows = 36;
let sink = "";
stdout.on("data", (chunk) => {
  sink += chunk.toString();
});

const { createSanitizedStdin } = await import(`${distEsm}/stdin-sanitizer.js`);
const sanitizedStdin = createSanitizedStdin(stdin);

const React = (await import("react")).default;
const { render } = await import("ink");
const { TrayambakApp } = await import(`${distEsm}/index.js`);

const stripAnsi = (text) =>
  text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "ok" : "FAIL"}: ${label}`);
  if (!ok) {
    failures += 1;
    console.error("--- window tail ---");
    console.error(stripAnsi(sink).slice(-600));
  }
};

const instance = render(
  React.createElement(TrayambakApp, {
    config: {
      themeName: "trayambak-dark", // skip ThemePicker
      baseUrl: "http://127.0.0.1:9/api", // unroutable — no network ever needed
      apiKey: "test-key",
      model: "test/model",
      cwd: process.cwd(),
    },
    modelName: "test/model",
    permissionMode: "ask",
    onExit: () => {},
  }),
  { stdin: sanitizedStdin, stdout, patchConsole: false },
);

const typeText = async (text) => {
  for (const ch of text) {
    stdin.write(ch);
    await wait(15);
  }
};

await wait(900);

// ── /theme night-sky ───────────────────────────────────────────────────────
sink = "";
await typeText("/theme night-sky");
await wait(200);
stdin.write("\r");
await wait(800);

check(sink.includes("Theme switched to night-sky"), "/theme night-sky posts confirmation");
check(
  // Root frame border repaints in theme.primary EVERY frame: night-sky
  // primary #82aaff. (Was: theme.border via the footer box — the footer
  // went borderless, so nothing persistent wears .border anymore. The
  // slash menu wears it, but only while open; asserting it made the
  // check depend on menu timing instead of the subscription.)
  sink.includes("38;2;130;170;255"),
  "frames repaint in night-sky primary (#82aaff) — subscription re-render live",
);

// ── /themes marker follows the live theme ───────────────────────────────
sink = "";
await typeText("/themes");
await wait(200);
stdin.write("\r");
await wait(800);

check(
  // Full sink, not the window: the 53-theme list exceeds the in-frame
  // budget, so the ● line may scroll into <Static> scrollback — which the
  // append-only sink retains.
  stripAnsi(sink).includes("● night-sky"),
  "/themes dots the live theme (not boot config)",
);

instance.unmount();
fs.rmSync(sandbox, { recursive: true, force: true });

console.log(failures === 0 ? "THEME_SWITCH_SMOKE_OK" : `THEME_SWITCH_SMOKE_FAIL ${failures}`);
process.exit(failures === 0 ? 0 : 1);
