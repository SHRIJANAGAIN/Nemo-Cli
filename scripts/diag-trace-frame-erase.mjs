/* Is each frame rewrite IN PLACE or APPENDED?
 *
 * Ink rewrites a frame by erasing it first: cursor-up × lineCount, then the
 * new rows. A frame that lands somewhere NEW (the clone the user sees) has no
 * erase in front of it — it is preceded by a newline / plain cursor move
 * instead. This prints the 40 bytes before every top-border write so the two
 * are unmistakable, and counts them.
 *
 * Run: node scripts/diag-trace-frame-erase.mjs <trace-file> [samples]
 */
import fs from "node:fs"

const file = process.argv[2]
const samples = Number(process.argv[3] ?? 8)
if (!file) {
  process.stderr.write("usage: node scripts/diag-trace-frame-erase.mjs <trace-file> [samples]\n")
  process.exit(2)
}

const raw = fs.readFileSync(file, "utf8")
const log = (...a) => process.stdout.write(a.join(" ") + "\n")

// Visible form of the last few bytes before each frame start.
const ESCAPES = [
  [/\x1b\[(\d+)A/g, "UP:$1"],
  [/\x1b\[2J/g, "CLR"],
  [/\x1b\[H/g, "HOME"],
  [/\x1b\[0G/g, "COL0"],
  [/\x1b\[2K/g, "EL"],
  [/\r/g, "CR"],
  [/\n/g, "LF"],
]

const hits = []
for (const m of raw.matchAll(/╭─/g)) hits.push(m.index)
log(`file: ${file}`)
log(`bytes: ${raw.length} | frame starts (top border): ${hits.length}`)

let erased = 0
let appended = 0
const kinds = []
for (const at of hits) {
  const before = raw.slice(Math.max(0, at - 24), at)
  const kindsBefore = []
  for (const [re, label] of ESCAPES) {
    const found = before.match(re)
    if (found) kindsBefore.push(label.replace("$1", found[found.length - 1]?.[1] ?? "?"))
  }
  // An erase is a cursor-up inside the window just behind the frame.
  const hasErase = kindsBefore.some((k) => k.startsWith("UP:"))
  if (hasErase) erased++
  else appended++
}

log(`frames preceded by a cursor-up (in place): ${erased}`)
log(`frames with NO erase in front (appended): ${appended}`)

log("── context before the first frames ──")
for (const at of hits.slice(0, samples)) {
  const before = raw.slice(Math.max(0, at - 30), at)
  const shown = before
    .replace(/\x1b\[(\d*)A/g, (_m, n) => `^${n || 1}`)
    .replace(/\x1b\[2J/g, "CLR")
    .replace(/\x1b\[H/g, "HOME")
    .replace(/\x1b\[0G/g, "COL0")
    .replace(/\x1b\[2K/g, "EL")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "?")
    .replace(/\r/g, "CR")
    .replace(/\n/g, "LF")
  log(`@${String(at).padStart(8)}  ${shown}`)
}