/* Byte-stream analyzer for a TRAYAMBAK_TRACE capture (or any captured stdout).
 *
 * The boot frame leak is a line-accounting desync: ink counts LINES, the
 * console reflows them into ROWS. So the two numbers that matter are
 *   - how wide the widest written line is vs the terminal width (a line that
 *     is exactly the old width reflows into two rows when the window narrows
 *     — ink's erase then misses it forever), and
 *   - how many times a full frame is re-printed instead of erased in place.
 *
 * Run: node scripts/diag-trace-analyze.mjs <trace-file> [cols]
 */
import fs from "node:fs"

const file = process.argv[2]
const cols = Number(process.argv[3] ?? 120)
if (!file) {
  process.stderr.write("usage: node scripts/diag-trace-analyze.mjs <trace-file> [cols]\n")
  process.exit(2)
}

// The trace is raw stdout BYTES; the frame is UTF-8 box art. Decoding as
// latin1 would count every multi-byte glyph as several cells and fake an
// overflow that isn't there (and hide one that is).
const raw = fs.readFileSync(file, "utf8")
const count = (re) => (raw.match(re) ?? []).length

const cleared = { "2J": count(/\x1b\[2J/g), "3J": count(/\x1b\[3J/g), home: count(/\x1b\[H/g) }
const cursorUp = count(/\x1b\[\d*A/g)
const eraseLine = count(/\x1b\[2K/g)
const caretHidden = count(/\x1b\[\?25l/g)
const mouseOff = count(/\x1b\[\?100[06]l/g)
const composer = count(/Ask Trayambak to do anything/g)
const topBorder = count(/╭─/g)
const bottomBorder = count(/╰─/g)

// Widest physical line and how many lines sit exactly AT the terminal width
// (the reflow trigger) or above it (already wrapping).
const stripped = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
const lines = stripped.split(/\r?\n/)
let max = 0
let atCols = 0
let overCols = 0
const overSamples = []
for (const line of lines) {
  const w = [...line].length
  if (w > max) max = w
  if (w === cols) atCols++
  if (w > cols) {
    overCols++
    if (overSamples.length < 5) overSamples.push({ w, text: line.slice(0, 60) })
  }
}

const log = (...a) => process.stdout.write(a.join(" ") + "\n")
log(`file: ${file}`)
log(`bytes: ${raw.length}`)
log(`clears: 2J=${cleared["2J"]} 3J=${cleared["3J"]} home=${cleared.home}`)
log(`cursor-up=${cursorUp} eraseLine=${eraseLine} caretHide=${caretHidden} mouseOff=${mouseOff}`)
log(`composer prints=${composer} topBorder=${topBorder} bottomBorder=${bottomBorder}`)
log(`widest written line: ${max} cells (cols=${cols}) | lines exactly ${cols}: ${atCols} | lines over: ${overCols}`)
for (const s of overSamples) log(`  OVER ${s.w}: ${JSON.stringify(s.text)}`)