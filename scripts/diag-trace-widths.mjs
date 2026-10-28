/* Track the width of every full-width border line across a capture.
 *
 * The clone paste shows frames getting steadily WIDER as they stack. A frame
 * wider than the terminal wraps, and a wrapped frame occupies more rows than
 * Ink counted — so its erase misses and the next frame lands below it. That is
 * the clone mechanism, and the width progression is its fingerprint.
 *
 * Run: node scripts/diag-trace-widths.mjs <trace-file>
 */
import fs from "node:fs"

const file = process.argv[2]
if (!file) {
  process.stderr.write("usage: node scripts/diag-trace-widths.mjs <trace-file>\n")
  process.exit(2)
}

const raw = fs.readFileSync(file, "utf8")
const log = (...a) => process.stdout.write(a.join(" ") + "\n")

const samples = []
let cursor = 0
while (cursor < raw.length && samples.length < 400) {
  const nl = raw.indexOf("\n", cursor)
  if (nl === -1) break
  const chunk = raw.slice(cursor, nl)
  cursor = nl + 1
  const plain = chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
  if (!plain.startsWith("╭")) continue
  samples.push({ at: cursor, w: [...plain].length })
}

log(`file: ${file}`)
log(`full-width border rows sampled: ${samples.length}`)
if (samples.length === 0) {
  log("no border rows — nothing to compare")
  process.exit(0)
}

const widths = samples.map((s) => s.w)
const uniq = [...new Set(widths)].sort((a, b) => a - b)
log(`distinct widths: ${uniq.join(", ")}`)
log(`first 20 widths: ${widths.slice(0, 20).join(", ")}`)
log(`last 20 widths: ${widths.slice(-20).join(", ")}`)

// Growth over the capture, and whether it is monotone (a drag) or a step.
const first = widths[0]
const last = widths[widths.length - 1]
log(`first=${first} last=${last} delta=${last - first}`)
let rising = 0
for (let i = 1; i < widths.length; i++) if (widths[i] > widths[i - 1]) rising++
log(`steps that got WIDER: ${rising} / ${widths.length - 1}`)

// Distinct widths in order of first appearance = the drag path.
const seen = []
for (const w of widths) if (seen[seen.length - 1] !== w) seen.push(w)
log(`width path (in order): ${seen.join(" → ")}`)