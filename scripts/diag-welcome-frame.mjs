/* Capture the REAL NemoApp welcome frame (past BootCine) as text.
 *
 * diag-first-screen.mjs waits only 1500 ms, but BootCine plays for a
 * not-first-run boot (App.tsx: showBootCine = !isFirstRun && !bootCineDone
 * && !initialPrompt) — so it reports "NO (BAD)" while the boot animation is
 * still on screen, before WelcomeScreen ever mounts. This waits it out and
 * reports where the frame walls (│) land, which is what shows the structure
 * without needing a screenshot.
 *
 * Run: node scripts/diag-welcome-frame.mjs [cols]
 */
import { PassThrough } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, "..")
const distEsm = pathToFileURL(path.join(repo, "dist", "packages", "tui", "src", "ink-app-esm")).href
process.env.NEMO_HOME = repo

const COLS = Number(process.argv[2] ?? 120)
const ROWS = 40

const { createScreen } = await import("./vt-screen.mjs")
const stdin = new PassThrough()
stdin.isTTY = true
stdin.setRawMode = () => {}
stdin.ref = () => {}
stdin.unref = () => {}

const { createSanitizedStdin } = await import(`${distEsm}/stdin-sanitizer.js`)
const sanitizedStdin = createSanitizedStdin(stdin)

const stdout = new PassThrough()
stdout.isTTY = true
stdout.columns = COLS
stdout.rows = ROWS
const screen = createScreen(COLS, ROWS)
stdout.on("data", (c) => screen.write(c.toString()))

const React = (await import("react")).default
const { render } = await import("ink")
const { NemoApp } = await import(`${distEsm}/index.js`)
const { loadConfig } = await import(pathToFileURL(path.join(repo, "dist", "apps", "runtime", "src", "config.js")).href)

const instance = render(
  React.createElement(NemoApp, {
    config: {
      ...loadConfig(),
      baseUrl: "http://127.0.0.1:9/api",
      apiKey: "k",
      model: "test/m",
      cwd: repo,
    },
    modelName: "test/m",
    permissionMode: "ask",
    onExit: () => {},
  }),
  { stdin: sanitizedStdin, stdout, patchConsole: false },
)

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stdout.write(a.join(" ") + "\n")

// Poll until BootCine yields (or give up), so we report the steady frame.
let snapshot = ""
let seen = ""
for (let i = 0; i < 30; i++) {
  await wait(500)
  snapshot = screen.snapshotFull().join("\n")
  if (snapshot.includes("Welcome To Nemo CLI")) {
    seen = "WELCOME"
    break
  }
  if (snapshot.includes("Welcome to Nemo CLI!")) {
    seen = "SPLASH"
    break
  }
}
log(`settled on: ${seen || "NEITHER (after 15s)"}`)
log(`cols=${COLS}`)
log("── rows ──")
screen.snapshotFull().forEach((r, i) => {
  const walls = []
  for (let c = 0; c < r.length; c++) if (r[c] === "\u2502") walls.push(c)
  const sig = walls.length ? `  walls@${walls.join(",")}` : ""
  log(`${String(i).padStart(2, " ")}|${r}${sig}`)
})

instance.unmount()
await wait(100)
process.exit(0)
