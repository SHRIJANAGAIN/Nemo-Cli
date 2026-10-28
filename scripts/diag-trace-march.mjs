/* Where does each frame actually land? Cursor simulation across a capture.
 *
 * Ink repaints by cursor-up + rewrite, so a healthy stream reprints every
 * frame at the SAME buffer row. A marching frame (the clones) shows up as the
 * frame-top border landing one row lower on every repaint. This simulates the
 * cursor through the byte stream — inside an anchor-free segment every move
 * is relative, so the result is exact regardless of what ESC[H means on any
 * particular terminal.
 *
 * Split points: ESC[2J (viewport clear) and ESC[H (home). Within a segment,
 * only relative moves happen: cursor-up/down, next-line, printables (with
 * wrap at the given width), and newlines.
 *
 * Run: node scripts/diag-trace-march.mjs <trace-file> [wrapWidth]
 */
import fs from "node:fs"

const file = process.argv[2]
const WRAP = Number(process.argv[3] ?? 150)
if (!file) {
  process.stderr.write("usage: node scripts/diag-trace-march.mjs <trace-file> [wrapWidth]\n")
  process.exit(2)
}

const raw = fs.readFileSync(file, "utf8")
const log = (...a) => process.stdout.write(a.join(" ") + "\n")

// Tokenise: CSI sequences vs printable runs vs single control chars.
const tokens = []
const re =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]|\r|\n|[^\x1b\r\n]+/g
for (const m of raw.matchAll(re)) tokens.push(m[0])

const isFullBorderStart = (text) => {
  const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
  return plain.startsWith("╭")
}

let row = 0
let col = 0
let segment = 0
// segment -> list of rows where a full-width frame-top border was written
const landings = new Map()
const segStart = new Map()

const note = (tok) => {
  if (tok === "\x1b[2J" || tok === "\x1b[H") {
    segment++
    segStart.set(segment, row)
    row = 0
    col = 0
    return
  }
  if (tok === "\r") {
    col = 0
    return
  }
  if (tok === "\n") {
    row++
    col = 0
    return
  }
  let m = /^\x1b\[(\d*)A$/.exec(tok)
  if (m) {
    row -= m[1] === "" ? 1 : Number(m[1])
    return
  }
  m = /^\x1b\[(\d*)B$/.exec(tok)
  if (m) {
    row += m[1] === "" ? 1 : Number(m[1])
    return
  }
  m = /^\x1b\[(\d*)E$/.exec(tok)
  if (m) {
    row += m[1] === "" ? 1 : Number(m[1])
    col = 0
    return
  }
  m = /^\x1b\[(\d*)G$/.exec(tok)
  if (m) {
    col = (m[1] === "" ? 1 : Number(m[1])) - 1
    return
  }
  if (/^\x1b\[/.test(tok)) return // other CSI: no cursor motion we track
  if (/^\x1b\]/.test(tok)) return // OSC: no motion
  // Printable run: advance, wrapping at WRAP (deferred-wrap: a line of exactly
  // WRAP cells does NOT wrap until one more cell or a newline... a newline
  // after exactly WRAP cells stays on the next row without an extra row).
  const visible = [...tok.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")]
  if (isFullBorderStart(tok)) {
    if (!landings.has(segment)) landings.set(segment, [])
    landings.get(segment).push(row)
  }
  for (const _ch of visible) {
    if (col === WRAP) {
      row++
      col = 0
    }
    col++
  }
}

for (const t of tokens) note(t)

log(`file: ${file} | wrap=${WRAP}`)
log(`segments (split on 2J/H): ${segment + 1}`)
let marched = 0
for (const [seg, rows] of landings) {
  if (rows.length < 3) continue
  const drift = rows[rows.length - 1] - rows[0]
  const per = drift / (rows.length - 1)
  const flag = drift > 0 ? "  <-- MARCHING" : ""
  if (drift > 0) marched++
  log(
    `seg ${seg}: ${rows.length} frames, first row=${rows[0]}, last row=${rows[rows.length - 1]}, ` +
      `drift=${drift} (~${per.toFixed(2)}/frame)${flag}`,
  )
  if (rows.length <= 12) log(`   rows: ${rows.join(",")}`)
}
log(marched > 0 ? `MARCH DETECTED in ${marched} segment(s)` : "NO MARCH: every frame lands in place")