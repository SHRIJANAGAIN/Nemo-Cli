/* Boot-only clone probe: boot the REAL app on a fake TTY at a given geometry,
 * let it idle (NO resize events, NO input), then replay the captured stdout
 * through scripts/vt-screen.mjs — which models deferred wrap, scrolling and
 * scrollback — and count root-frame top-borders sitting in SCROLLBACK.
 *
 * Healthy boot = 0: every idle repaint rewrites in place. Any value > 0 means
 * an idle repaint scrolled a whole frame out of the viewport, which is the
 * "top clone" reported against the welcome screen.
 *
 * Unlike diag-boot-frame-leak (which counts bytes WRITTEN, so any repaint
 * looks suspicious), this counts what actually survives on screen — and it
 * writes the capture as UTF-8, so box-drawing glyphs round-trip correctly.
 *
 * Run: node scripts/diag-boot-clone.mjs [rows] [cols] [idleMs] [flags]
 *   flags: --prod     production boot (startup clear, Ink-default patchConsole,
 *                     warning fired by App's first render mid-paint)
 *          --alt      alternate-screen boot (?1049h + mouse-off, no clear)
 *          --pre      pre-print the config warning before render
 *          --resize   grow width mid-idle (the one event a real session logged)
 *          --shrink   shrink width mid-idle (the reflow that strands clones)
 *          --dump     print the final viewport
 *   exit 0 = clean, exit 1 = clone (scrollback frame OR stacked viewport frame)
 */
import { PassThrough } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, "..")
const distEsm = pathToFileURL(path.join(repo, "dist", "packages", "tui", "src", "ink-app-esm")).href

process.env.NEMO_HOME = repo
process.env.NEMO_GLYPHS = "unicode"

// Hostile argv (0/negative/NaN) must not kill the probe — a terminal's
// smallest reportable geometry is 1x1, so clamp at parse.
const ROWS = Math.max(1, Number(process.argv[2] ?? 37))
const COLS = Math.max(1, Number(process.argv[3] ?? 115))
const IDLE = Math.max(0, Number(process.argv[4] ?? 5000))

const { createScreen } = await import(pathToFileURL(path.join(here, "vt-screen.mjs")).href)
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

// `--pre` reproduces the real console state: config sanitisation prints its
// blanket-approval warning to the console BEFORE Ink takes over, and Ink never
// clears on start (2J=0 in every capture) — so those rows are already used by
// the time the first frame is laid out. The welcome frame is calibrated for a
// pristine screen, so this is the difference between the probe and reality.
const PRE =
  "nemo: ignoring blanket-approval settings from C:\\Users\\engli\\nemo\\.nemo\\config.json " +
  "\u2014 a repository cannot put the session into blanket-approval mode. Set it in ~/.nemo/config.json " +
  "or point at a file you trust with --config instead."
const preLines = process.argv.includes("--pre") ? Math.ceil(PRE.length / COLS) + 1 : 0

let raw = ""
stdout.on("data", (chunk) => {
  const text = chunk.toString()
  raw += text
  screen.write(text)
})

// `--prod` mirrors ink-repl.mjs's real boot instead of the minimal one:
//   1. the startup clear (2J 3J H + mouse-off) runs BEFORE render();
//   2. `patchConsole` stays at Ink's default (true) — ink-repl never sets it;
//      Ink's default stderr is process.stderr, so production sends the
//      patched console.warn to the real stderr (same TTY as stdout) — the
//      fake stderr below feeds that write into the screen;
//   3. the config is handed over WITHOUT calling loadConfig() here, so the
//      first React render is what calls the real loadConfig(), firing the
//      repo-config warning MID-PAINT through Ink's patched console.
// `--alt` mirrors ink-repl's alternate-screen boot: ?1049h + mouse-off tail,
// no clear (the alternate buffer starts blank by definition).
const prod = process.argv.includes("--prod")
const alt = process.argv.includes("--alt")
const fakeStderr = new PassThrough()
fakeStderr.on("data", (chunk) => {
  const text = chunk.toString()
  raw += text
  screen.write(text)
})
if (alt) {
  stdout.write("\x1b[?1049h")
  stdout.write(
    "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l",
  )
} else if (prod) {
  stdout.write(
    "\x1b[2J\x1b[3J\x1b[H\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l",
  )
}

const React = (await import("react")).default
const { render } = await import("ink")
const { NemoApp } = await import(`${distEsm}/index.js`)
const { loadConfig } = await import(
  pathToFileURL(path.join(repo, "dist", "apps", "runtime", "src", "config.js")).href,
)

// Raw file config for --prod: same CONTENT the parent CLI would serialize
// into NEMO_CONFIG_JSON, but without going through the dist
// loadConfig() — that would consume warnOnce before render() and the whole
// point of --prod is to let App's first render be the process's first
// (patched) warning, exactly like the spawned child process.
function readConfigFile() {
  const explicit = process.env.NEMO_CONFIG
  const candidates = explicit
    ? [explicit]
    : [path.join(repo, ".nemo", "config.json"), path.join(os.homedir(), ".nemo", "config.json")]
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"))
    } catch {
      /* unreadable config degrades to {} just like loadConfig() */
    }
  }
  return {}
}

if (preLines > 0) stdout.write(PRE + "\n")

// `--resize` replays the one event your session actually logged
// (13:16:09, 115->116, ANCHOR): grow the fake terminal's width mid-idle and
// let the guard respond. `--shrink` is the case where reflow bites: rows are
// exactly COLS wide, so narrowing the window splits each border row in two and
// the frame no longer fits.
const doResize = process.argv.includes("--resize")
const shrinkBy = process.argv.includes("--shrink") ? 20 : 0

// Mirror ink-repl.mjs exactly: the resize guard is constructed BEFORE render()
// (ink-repl L95) and attached right after it returns (L247) — one synchronous
// run with no event-loop turn in between, so no resize event can interleave.
// The guard traces to NEMO_RESIZE_LOG; keep the probe out of the repo's
// real nemo-resize.log.
process.env.NEMO_RESIZE_LOG = path.join(os.tmpdir(), "diag-boot-clone-resize.log")
const { createResizeRedrawGuard } = await import(`${distEsm}/resize-guard.js`)
const resizeGuard = createResizeRedrawGuard(stdout)

const instance = render(
  React.createElement(NemoApp, {
    // --prod must NOT call the dist loadConfig() here: production ink-repl
    // hands over env-JSON only (parent already warned), so the child's
    // warnOnce stays fresh until App.tsx's first render calls the real
    // loadConfig() — firing the warning MID-PAINT through Ink's patched
    // console. The config CONTENT still comes from the file, mirroring
    // what the parent would have put in NEMO_CONFIG_JSON.
    config: {
      ...(prod ? readConfigFile() : loadConfig()),
      baseUrl: "http://127.0.0.1:9/api",
      apiKey: "k",
      model: "test/m",
      cwd: repo,
    },
    modelName: "test/m",
    permissionMode: "ask",
    onExit: () => {},
  }),
  prod
    ? { stdin: sanitizedStdin, stdout, stderr: fakeStderr }
    : { stdin: sanitizedStdin, stdout, patchConsole: false },
)
resizeGuard.attach(instance)

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const bootAt = Date.now()
if (doResize || shrinkBy > 0) {
  await wait(1500)
  // Floor of 1: shrinking to zero width would fabricate a geometry no real
  // terminal reports (and used to crash the reflow oracle).
  const nextCols = Math.max(1, shrinkBy > 0 ? COLS - shrinkBy : COLS + 1)
  stdout.columns = nextCols
  screen.resizeTo(nextCols, ROWS)
  stdout.emit("resize")
}
await wait(IDLE - (Date.now() - bootAt))

const sb = screen.scrollbackRows()
const view = screen.snapshotFull()
const isRootTop = (line) => {
  const t = line.trimEnd()
  if (!t.startsWith("\u256d")) return false
  // Threshold against the LIVE width, not boot COLS: after --shrink/--resize
  // the frame — and every reflowed scrollback clone — is screen.size().cols
  // wide. The stale boot width let post-shrink clones fall under the bar and
  // verdict "clean" on a tree that was cloning.
  return [...t].length >= Math.floor(screen.size().cols * 0.8)
}
const sbTops = sb.filter(isRootTop).length
const totalTops = view.filter(isRootTop).length
const clears2J = (raw.match(/\x1b\[2J/g) ?? []).length
const home = (raw.match(/\x1b\[H/g) ?? []).length
const cursorUp = (raw.match(/\x1b\[\d+A/g) ?? []).length
const composerWrites = (raw.match(/Ask Nemo to do anything/g) ?? []).length
const warningWrites = (raw.match(/ignoring blanket-approval/g) ?? []).length
const clears3J = (raw.match(/\x1b\[3J/g) ?? []).length

const log = (...a) => process.stdout.write(a.join(" ") + "\n")
log(`geometry ${COLS}x${ROWS} idle=${IDLE}ms bytes=${raw.length} preLines=${preLines} resize=${doResize} shrink=${shrinkBy} prod=${prod} alt=${alt}`)
log(`frame writes: composer=${composerWrites} clears 2J=${clears2J} 3J=${clears3J} home=${home} cursorUp=${cursorUp}`)
log(`config warning writes reaching the screen: ${warningWrites}`)
log(`SCROLLBACK root top-borders: ${sbTops}${sbTops > 0 ? "  <-- BOOT CLONE" : "  (clean)"}`)
log(`total root top-borders (scrollback+viewport): ${totalTops}`)
log(`scrollback rows: ${sb.length}`)
// Clone = a frame stranded in scrollback (unreachable by any 2J) OR more than
// one root frame stacked on screen (scrollback + live viewport together).
const fail = sbTops > 0 || totalTops > 1
log(`verdict: ${fail ? "CLONE" : "clean"}`)
if (sbTops > 0) {
  const first = sb.findIndex(isRootTop)
  log(`first leaked frame at scrollback row ${first}`)
}
if (process.argv.includes("--dump")) {
  const lines = view.slice(-ROWS)
  lines.forEach((l, idx) => log(String(idx).padStart(3) + "|" + l))
}

const out = path.join(os.tmpdir(), "boot-utf8.bin")
fs.writeFileSync(out, raw, "utf8")
log(`utf8 stream: ${out}`)

instance.unmount()
await wait(100)
process.exit(fail ? 1 : 0)
