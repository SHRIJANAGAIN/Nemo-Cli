/* Rendered-width audit of a captured stream: strip ANSI, split the FIRST frame
 * into rows and report the width distribution. The frame's own border row is
 * the app's idea of the terminal width; if the real window is even one cell
 * narrower, every one of those rows wraps and the frame creeps down a row per
 * line — which is what the frame clones are made of.
 *
 * Run: node scripts/diag-trace-width.mjs <trace-file>
 */
import fs from "node:fs"

const file = process.argv[2]
if (!file) {
  process.stderr.write("usage: node scripts/diag-trace-width.mjs <trace-file>\n")
  process.exit(2)
}

const raw = fs.readFileSync(file, "utf8")
const log = (...a) => process.stdout.write(a.join(" ") + "\n")

// Strip CSI/OSC, then take the text the terminal would show for the first
// frame: everything up to the first cursor-up (ink starts erasing there).
const body = raw.slice(0, 200_000)
const firstFrame = body.split("\x1b[999D")[0] ?? body
const plain = firstFrame
  // eslint-disable-next-line no-control-regex
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
  .replace(/\r/g, "")

const rows = plain.split("\n").filter((r) => r.length > 0)
const widths = rows.map((r) => [...r].length)
const sorted = [...widths].sort((a, b) => a - b)
const histogram = new Map()
for (const w of widths) histogram.set(w, (histogram.get(w) ?? 0) + 1)

log(`file: ${file}`)
log(`first-frame rows: ${rows.length}`)
log(`width min=${sorted[0]} median=${sorted[Math.floor(sorted.length / 2)]} max=${sorted[sorted.length - 1]}`)
log("── width histogram (top 8) ──")
for (const [w, n] of [...histogram].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  log(`  ${String(w).padStart(4)} cells × ${n}`)
}
const border = rows.find((r) => r.trimStart().startsWith("╭"))
if (border) log(`top border row: ${[...border].length} cells`)
const widest = rows[widths.indexOf(sorted[sorted.length - 1])]
log(`widest row starts: ${JSON.stringify(widest.slice(0, 40))}`)