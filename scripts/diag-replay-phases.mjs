/* Split a captured stream at its first generation frame and report the clone
 * count per phase.
 *
 * The idle WelcomeScreen and a live turn paint very differently, and the clone
 * bug was reported for both. This finds the first frame that is NOT the idle
 * screen (any frame carrying assistant prose), then replays each phase through
 * the VT simulator separately and reports how many frame top-borders / composer
 * lines are on screen at the end of that phase.
 *
 * Run: node scripts/diag-replay-phases.mjs <trace-file> [cols] [rows]
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const file = process.argv[2]
const cols = Number(process.argv[3] ?? 149)
const rows = Number(process.argv[4] ?? 40)
if (!file) {
  process.stderr.write("usage: node scripts/diag-replay-phases.mjs <trace-file> [cols] [rows]\n")
  process.exit(2)
}

const raw = fs.readFileSync(file, "utf8")
const { createScreen } = await import(pathToFileURL(path.join(here, "vt-screen.mjs")).href)
const log = (...a) => process.stdout.write(a.join(" ") + "\n")

const report = (label, bytes) => {
  const screen = createScreen(cols, rows)
  screen.write(bytes)
  const view = screen.snapshotFull()
  const isRootTop = (line) => {
    const t = line.trimEnd()
    return t.startsWith("╭") && [...t].length >= Math.floor(cols * 0.8)
  }
  const tops = view.filter(isRootTop).length
  const composers = view.filter((l) => l.includes("Ask Trayambak")).length
  log(
    `${label.padEnd(22)} bytes=${String(bytes.length).padStart(8)}  rootTops=${tops}  composers=${composers}` +
      `${tops > 1 || composers > 1 ? "   <-- CLONES" : ""}`,
  )
  return { tops, composers, view }
}

// Phase split: the idle screen is the WelcomeScreen (logo art + clock + cwd).
// The first user message ends it. "Ask Trayambak" plus a second frame's worth
// of content is the give-away, so use the first full-width border that is NOT
// the opening one.
const borders = []
for (const m of raw.matchAll(/╭─/g)) {
  // Only count full-width runs.
  const start = m.index
  const nl = raw.indexOf("\n", start)
  const line = nl === -1 ? raw.slice(start) : raw.slice(start, nl)
  const plain = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
  if ([...plain].length >= Math.floor(cols * 0.8)) borders.push(start)
}
log(`file: ${file} | full-width border writes: ${borders.length}`)

report("whole stream", raw)
if (borders.length > 2) {
  const split = borders[2]
  report("up to 2nd border", raw.slice(0, split))
  report("after 2nd border", raw.slice(split))
  report("last third", raw.slice(Math.floor(raw.length * 0.66)))
  report("last 40KB", raw.slice(Math.max(0, raw.length - 40000)))
}