/* Diagnostic: where does user text next to the logo come from?
 * Boot the real app in a fake TTY, submit a distinctive message, then inspect
 * the RAW byte stream for:
 *   - how often Ink does a full clearTerminal (ESC[3J) — i.e. is every frame
 *     a full clear+rewrite (Windows fullscreen path) or the erase-lines path;
 *   - whether any single written LINE contains both "TRAYAMBAK" and the
 *     user's text (app/Ink-level merge) or not (screen-only artifact).
 */
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const distEsm = "file:///C:/Users/engli/trayambak/dist/packages/tui/src/ink-app-esm";

const stdin = new PassThrough();
stdin.isTTY = true;
stdin.setRawMode = () => {};
stdin.ref = () => {};
stdin.unref = () => {};

const { createSanitizedStdin } = await import(`${distEsm}/stdin-sanitizer.js`);
const sanitizedStdin = createSanitizedStdin(stdin);

const stdout = new PassThrough();
stdout.isTTY = true;
stdout.columns = 154;
stdout.rows = 40;
let sink = "";
stdout.on("data", (chunk) => {
  sink += chunk.toString();
});

const React = (await import("react")).default;
const { render } = await import("ink");
const { TrayambakApp } = await import(`${distEsm}/index.js`);

const instance = render(
  React.createElement(TrayambakApp, {
    config: {
      themeName: "trayambak-dark",
      baseUrl: "http://127.0.0.1:9/api",
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stripAnsi = (t) =>
  t
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[=>]/g, "");

const MARK = "ZZUNIQUEMARKERZZ";

await wait(600);
const bootCount = (sink.match(/\x1b\[3J/g) ?? []).length;
console.log(`boot: bytes=${sink.length} clearTerminal(ESC[3J)=${bootCount}`);

// Submit a distinctive message.
stdin.write(MARK);
await wait(150);
stdin.write("\r");
await wait(900);

const total3J = (sink.match(/\x1b\[3J/g) ?? []).length;
const total2J = (sink.match(/\x1b\[2J/g) ?? []).length;
const eraseLines = (sink.match(/\x1b\[2K/g) ?? []).length;
console.log(`after submit: bytes=${sink.length} ESC[3J=${total3J} ESC[2J=${total2J} ESC[2K=${eraseLines}`);

// 1) Does any single written line contain BOTH the logo and the marker?
const stripped = stripAnsi(sink);
const lines = stripped.split("\n");
const merged = lines.filter((l) => l.includes("TRAYAMBAK") && l.includes(MARK));
console.log(`lines containing both TRAYAMBAK and marker: ${merged.length}`);
for (const l of merged.slice(0, 5)) console.log("  MERGED>", JSON.stringify(l.slice(0, 200)));

// 2) Where does the marker appear — print every line containing it (trimmed).
const markerLines = lines.filter((l) => l.includes(MARK));
console.log(`lines containing marker: ${markerLines.length}`);
for (const l of markerLines.slice(0, 8)) console.log("  MARK>", JSON.stringify(l.slice(0, 200)));

// 3) Print all lines containing TRAYAMBAK (the logo rows), trimmed.
const logoLines = lines.filter((l) => l.includes("TRAYAMBAK"));
console.log(`lines containing TRAYAMBAK: ${logoLines.length}`);
for (const l of logoLines.slice(-6)) console.log("  LOGO>", JSON.stringify(l.slice(0, 200)));

// Persist raw + report for offline inspection.
import { writeFileSync } from "node:fs";
writeFileSync(path.join(here, "diag-header.raw.txt"), sink);

instance.unmount();
await wait(50);
process.exit(0);
