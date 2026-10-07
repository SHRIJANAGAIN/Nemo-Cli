/* Replay a real captured stdout stream through the repo's VT simulator and
 * report what the screen actually ends up looking like.
 *
 * This is the reproduction harness for the frame clones: it feeds the exact
 * bytes the terminal received (TRAYAMBAK_TRACE capture) into scripts/
 * vt-screen.mjs — the same simulator the repo's own smoke tests assert on —
 * and then counts how many frame top-borders are visible at once. More than
 * one = the clones, reproduced offline with zero guessing.
 *
 * Run: node scripts/diag-replay-clones.mjs <trace-file> [cols] [rows]
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const file = process.argv[2]
const cols = Number(process.argv[3] ?? 149)
const rows = Number(process.argv[4] ?? 40)
if (!file) {
  process.stderr.write("usage: node scripts/diag-replay-clones.mjs <trace-file> [cols] [rows]\n")
  process.exit(2)
}

const raw = fs.readFileSync(file, "utf8")
const { createScreen } = await import(pathToFileURL(path.join(here, "vt-screen.mjs")).href)
const screen = createScreen(cols, rows)
screen.write(raw)

const view = screen.snapshotFull()
const log = (...a) => process.stdout.write(a.join(" ") + "\n")

// The root frame opens with a full-width rounded top border. A footer panel is
// only a few cells wide, so width separates them cleanly.
const isRootTop = (line) => {
  const t = line.trimEnd()
  if (!t.startsWith("╭")) return false
  return [...t].length >= Math.floor(cols * 0.8)
}
const tops = []
view.forEach((line, i) => {
  if (isRootTop(line)) tops.push(i)
})

log(`file: ${file}`)
log(`replayed ${raw.length} bytes into a ${cols}x${rows} viewport`)
log(`root frame top-borders visible at once: ${tops.length}${tops.length > 1 ? "  <-- CLONES" : "  (single frame)"}`)
log(`at rows: ${tops.join(",") || "(none)"}`)

// A clone also shows up as the same frame repeated: count the clock line, which
// appears exactly once per live frame.
const clocks = view.filter((l) => /\d\d:\d\d:\d\d/.test(l)).length
log(`clock lines on screen: ${clocks}${clocks > 1 ? "  <-- CLONES" : ""}`)
const composers = view.filter((l) => l.includes("Ask Trayambak")).length
log(`composer lines on screen: ${composers}${composers > 1 ? "  <-- CLONES" : ""}`)

log("── screen (first 12 rows) ──")
view.slice(0, 12).forEach((r, i) => log(`${String(i).padStart(3, " ")}│${r}`))