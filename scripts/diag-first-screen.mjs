/* First-screen verification: boot the REAL TrayambakApp with the REAL
 * environment (no sandbox — TRAYAMBAK_HOME = repo, config resolved exactly
 * like ink-repl: prop = loadConfig() from disk) and prove boot never
 * hijacks into the session picker:
 *   - post factory reset (no config file, empty store) → first-run
 *     SplashScreen ("Welcome to Trayambak CLI!"),
 *   - steady state (config saved, sessions in store) → WelcomeScreen
 *     ("Welcome To Trayambak CLI") — the picker must NOT auto-open.
 *
 * Run: node scripts/diag-first-screen.mjs     (exit 0 = first screen confirmed)
 */
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const distEsm = pathToFileURL(path.join(repo, "dist", "packages", "tui", "src", "ink-app-esm")).href;

// Real store + real config resolution (cwd of this script = repo).
process.env.TRAYAMBAK_HOME = repo;

const { createScreen } = await import("./vt-screen.mjs");
const stdin = new PassThrough();
stdin.isTTY = true;
stdin.setRawMode = () => {};
stdin.ref = () => {};
stdin.unref = () => {};
const { createSanitizedStdin } = await import(`${distEsm}/stdin-sanitizer.js`);
const sanitizedStdin = createSanitizedStdin(stdin);

const COLS = 120;
const ROWS = 40;
const stdout = new PassThrough();
stdout.isTTY = true;
stdout.columns = COLS;
stdout.rows = ROWS;
const screen = createScreen(COLS, ROWS);
stdout.on("data", (chunk) => screen.write(chunk.toString()));

const React = (await import("react")).default;
const { render } = await import("ink");
const { TrayambakApp } = await import(`${distEsm}/index.js`);
// Same config resolution the real CLI uses: parent reads the file, passes it
// through TRAYAMBAK_CONFIG_JSON, ink-repl hands it to TrayambakApp as the
// prop. Mirroring that keeps this diag honest in BOTH states: fresh reset
// (no file → splash) and after onboarding (file theme → welcome, no picker).
const { loadConfig } = await import(
  pathToFileURL(path.join(repo, "dist", "apps", "runtime", "src", "config.js")).href
);

const instance = render(
  React.createElement(TrayambakApp, {
    config: {
      ...loadConfig(),
      baseUrl: "http://127.0.0.1:9/api", // unroutable — never hit
      apiKey: "k",
      model: "test/m",
      cwd: repo,
    },
    modelName: "test/m",
    permissionMode: "ask",
    onExit: () => {},
  }),
  { stdin: sanitizedStdin, stdout, patchConsole: false },
);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => process.stdout.write(a.join(" ") + "\n");

await wait(1500);
const rows = screen.snapshotFull();
const text = rows.join("\n");

// Two legitimate first screens: first-run splash (no saved theme yet) or
// the WelcomeScreen with the logo (config saved). Anything else at boot —
// above all the session picker — is the bug this guards.
const splash = text.includes("Welcome to Trayambak CLI!");   // SplashScreen (fresh reset)
const welcome = text.includes("Welcome To Trayambak CLI");   // WelcomeScreen (steady state)
const firstScreen = splash || welcome;
const pickerVisible = /sess_[a-z0-9]{6,}|Select a session|Resumed session|\+ New Chat/.test(text);

log(`first screen: ${firstScreen ? (splash ? "SPLASH (fresh reset)" : "WELCOME (steady state)") : "NO (BAD)"}`);
log(`session picker / old transcript visible: ${pickerVisible ? "YES (BAD)" : "no"}`);
log("── screen (first 30 rows) ──");
rows.slice(0, 30).forEach((r, i) => log(`${String(i).padStart(3, " ")}│${r}`));

instance.unmount();
await wait(100);
if (!firstScreen || pickerVisible) {
  log("FIRST_SCREEN_FAIL");
  process.exit(1);
}
log("FIRST_SCREEN_OK");
process.exit(0);
