/* Boot-time frame-leak probe: the idle WelcomeScreen repaints every 500ms
 * (clock + logo phase). If those repaints APPEND instead of rewriting in
 * place, the whole frame stacks in scrollback once per tick ("same structure
 * copy-paste ho raha"). This boots the REAL NemoApp against a fake TTY,
 * captures raw stdout for a few seconds and reports whether each repaint
 * re-prints the full frame or erases first.
 *
 * Run: node scripts/diag-boot-frame-leak.mjs [rows] [cols]
 *   exit 0 = no leak (repaints rewrite in place)
 *   exit 1 = LEAK (full frame re-printed per tick)
 */
import { PassThrough } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"
import fs from "node:fs"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, "..")
const distEsm = pathToFileURL(path.join(repo, "dist", "packages", "tui", "src", "ink-app-esm")).href

process.env.NEMO_HOME = repo
process.env.NEMO_GLYPHS = "unicode"

const ROWS = Number(process.argv[2] ?? 40)
const COLS = Number(process.argv[3] ?? 120)

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

let raw = ""
stdout.on("data", (chunk) => {
  const text = chunk.toString()
  raw += text
  screen.write(text)
})

const React = (await import("react")).default
const { render } = await import("ink")
const { NemoApp } = await import(`${distEsm}/index.js`)
const { loadConfig } = await import(
  pathToFileURL(path.join(repo, "dist", "apps", "runtime", "src", "config.js")).href
)

const instance = render(
  React.createElement(NemoApp, {
    config: { ...loadConfig(), baseUrl: "http://127.0.0.1:9/api", apiKey: "k", model: "test/m", cwd: repo },
    modelName: "test/m",
    permissionMode: "ask",
    onExit: () => {},
  }),
  { stdin: sanitizedStdin, stdout, patchConsole: false },
)

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stdout.write(a.join(" ") + "\n")

await wait(1200)
const bootBytes = raw.length
const bootComposer = (raw.match(/Ask Nemo to do anything/g) ?? []).length
await wait(4000)

const composerCount = (raw.match(/Ask Nemo to do anything/g) ?? []).length - bootComposer
const logoCount = (raw.match(/⣿/g) ?? []).length
const borderCount = (raw.match(/╭─/g) ?? []).length
const clearScreen = (raw.match(/\x1b\[2J/g) ?? []).length
const clearScrollback = (raw.match(/\x1b\[3J/g) ?? []).length
const homeCount = (raw.match(/\x1b\[H/g) ?? []).length
const cursorUp = (raw.match(/\x1b\[\d+A/g) ?? []).length
const afterBootBytes = raw.length - bootBytes

// Widest physical line ink actually wrote (before wrapping the terminal would
// wrap it). A line wider than COLS is the wrap that desyncs ink's line count.
const stripped = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
const widths = stripped.split(/\r?\n/).map((l) => [...l].length)
const maxWidth = widths.reduce((m, w) => Math.max(m, w), 0)

log(`rows=${ROWS} cols=${COLS}`)
log(`bytes after boot window: ${afterBootBytes}`)
log(`full-frame composer lines printed during 4s: ${composerCount} (expect <=1)`)
log(`logo glyph writes during 4s: ${logoCount}`)
log(`top-border writes during 4s: ${borderCount}`)
log(`clears: 2J=${clearScreen} 3J=${clearScrollback} home=${homeCount} cursorUp=${cursorUp}`)
log(`widest written line (cells): ${maxWidth} (terminal cols=${COLS}${maxWidth > COLS ? "  <-- WRAPS" : ""})`)

const screenRows = screen.snapshotFull()
const logoOnScreen = screenRows.filter((r) => r.includes("⣿")).length
log(`logo rows on the live screen: ${logoOnScreen} (one frame = 1 set)`)
log("── last 6 screen rows ──")
screenRows.slice(-6).forEach((r, i) => log(`${String(i).padStart(3, " ")}│${r}`))

// Dump the exact byte stream so the conhost replay probe (diag-conhost-replay.ps1)
// can push it through a REAL Windows console — the only place the fullscreen-
// clear mask vs incremental-erase difference shows up.
const dump = path.join(process.env.TEMP ?? ".", "nemo-boot-bytes.bin")
fs.writeFileSync(dump, Buffer.from(raw, "binary"))
log(`byte stream dumped: ${dump} (${raw.length} chars)`)

instance.unmount()
await wait(100)

// Healthy: the animated idle screen repaints in place, so the composer line
// is re-printed at most once in the window (and the logo never re-prints).
const leaked = composerCount > 1
log(leaked ? "BOOT_FRAME_LEAK" : "BOOT_FRAME_OK")
process.exit(leaked ? 1 : 0)