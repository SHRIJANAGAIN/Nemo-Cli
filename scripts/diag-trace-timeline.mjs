/* Byte-stream timeline: WHERE each clear / frame write lands, in order.
 *
 * The clone bug looks like "every repaint re-prints a whole frame at a new
 * spot". This prints the event order (clear, home, logo top row, composer line)
 * with byte offsets so the pattern is visible instead of guessed.
 *
 * Run: node scripts/diag-trace-timeline.mjs <trace-file> [maxEvents]
 */
import fs from "node:fs"

const file = process.argv[2]
const max = Number(process.argv[3] ?? 40)
if (!file) {
  process.stderr.write("usage: node scripts/diag-trace-timeline.mjs <trace-file> [maxEvents]\n")
  process.exit(2)
}

const raw = fs.readFileSync(file, "utf8")
const log = (...a) => process.stdout.write(a.join(" ") + "\n")

const MARKS = [
  { name: "CLEAR-2J", re: /\x1b\[2J/g },
  { name: "CLEAR-3J", re: /\x1b\[3J/g },
  { name: "HOME-H", re: /\x1b\[H/g },
  { name: "LOGO-TOP", re: /████████/g },
  { name: "COMPOSER", re: /Ask Trayambak to do anything/g },
  { name: "CLOCK", re: /\d\d:\d\d:\d\d/g },
  { name: "FOOTER", re: /opencode\/space-bunny-free/g },
]

const events = []
for (const m of MARKS) {
  for (const hit of raw.matchAll(m.re)) {
    // The clock fires twice per tick (date line + nothing else) — collapse
    // consecutive duplicates within 40 bytes so the timeline stays readable.
    events.push({ at: hit.index, name: m.name })
  }
}
events.sort((a, b) => a.at - b.at)

const deduped = []
for (const e of events) {
  const prev = deduped[deduped.length - 1]
  if (prev && prev.name === e.name && e.at - prev.at < 60) continue
  deduped.push(e)
}

log(`file: ${file}`)
log(`bytes: ${raw.length} | events: ${events.length} | after collapse: ${deduped.length}`)
log("── timeline ──")
for (const e of deduped.slice(0, max)) {
  // How many bytes since the previous event: a full-frame rewrite is thousands.
  const prev = deduped[deduped.length - 1] === e ? null : deduped[deduped.length - 1]
  const gap = prev ? e.at - prev.at : 0
  log(`${String(e.at).padStart(8)}  +${String(gap).padStart(6)}  ${e.name}`)
}
const clears = deduped.filter((e) => e.name === "CLEAR-2J").length
const frames = deduped.filter((e) => e.name === "LOGO-TOP").length
log(`── collapsed counts: 2J=${clears} logoTop=${frames} ──`)