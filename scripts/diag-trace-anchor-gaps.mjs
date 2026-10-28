/* When did each clear land? A resize DRAG arrives as a burst of events; a
 * feedback loop shows up as evenly spaced blanks forever. The gap histogram
 * tells the two apart — and the burst case needs coalescing, the loop case
 * needed the anchor removed (both were real; this says which one is left).
 *
 * Run: node scripts/diag-trace-anchor-gaps.mjs <trace-file>
 */
import fs from "node:fs"

const file = process.argv[2]
if (!file) {
  process.stderr.write("usage: node scripts/diag-trace-anchor-gaps.mjs <trace-file>\n")
  process.exit(2)
}

const raw = fs.readFileSync(file, "utf8")
const log = (...a) => process.stdout.write(a.join(" ") + "\n")

// Anchors are the 2J+H pairs this app writes (a clear with no ED3 behind it).
const at = []
for (const m of raw.matchAll(/\x1b\[2J\x1b\[H/g)) at.push(m.index)

// Frame writes: a top border row reaching the writer means a full frame.
let frames = 0
for (const m of raw.matchAll(/╭─/g)) frames++

log(`file: ${file}`)
log(`bytes: ${raw.length}`)
log(`anchors (2J+H): ${at.length} | top-border writes: ${frames}`)

const gaps = []
for (let i = 1; i < at.length; i++) gaps.push(at[i] - at[i - 1])
if (gaps.length === 0) {
  log("no anchor pairs — nothing fired after the boot clear")
  process.exit(0)
}
const sorted = [...gaps].sort((a, b) => a - b)
log(`gap bytes: min=${sorted[0]} median=${sorted[Math.floor(sorted.length / 2)]} max=${sorted[sorted.length - 1]}`)

// The idle tick writes ~7.9KB (clock+footer+composer). An anchor that lands
// roughly one tick apart is the loop; anchors packed far tighter than that
// are a drag burst.
const TICK = 7900
const loopish = gaps.filter((g) => g >= TICK * 0.6 && g <= TICK * 1.6).length
const burst = gaps.filter((g) => g < TICK * 0.6).length
log(`gaps ≈ one idle tick (loop signature): ${loopish}`)
log(`gaps packed tight (drag burst): ${burst}`)

// How many distinct widths were written — a drag walks through many.
const widths = new Set()
for (const m of raw.matchAll(/\x1b\[38;2;\d+;\d+;\d+m[^\n]{0,4}/g)) void m
for (const line of raw.split("\n").slice(0, 400)) {
  const plain = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
  if (plain.startsWith("╭")) widths.add([...plain].length)
}
log(`distinct top-border widths in the first frames: ${[...widths].sort((a, b) => a - b).join(",") || "(none)"}`)