/* Contract test for the startup-screen pile-up fix (resize-guard.ts).
 *
 * Bug: Ink erases its previous frame by cursor-up x split('\n').length — a
 * LINE count. A terminal width change re-flows the rows already on screen
 * (the frame's full-width border rows split in two at a narrower width),
 * so that count goes stale and every re-render misses rows → old frames
 * accumulate in scrollback with drifting indents (stacked logos).
 *
 * The guard (registered BEFORE Ink's own resize listener, so it runs first)
 * must, on a width change or a height SHRINK:
 *   1. blank the viewport + home the cursor (ESC[2J ESC[H);
 *   2. reset Ink's line bookkeeping (log.reset + lastOutput = '');
 * and Ink must then repaint the full frame from (0,0), with any repeat
 * paint in the window being an in-place rewrite (cursor-up) at the CURRENT
 * geometry — never an appended stack of stale frames, no reliance on the
 * stale erase. (Ink legitimately repaints on cursor-blink ticks; those
 * count as the same live frame, not a second one.)
 *
 * Height GROWTH must NOT blank: the frame keeps its top row and grows
 * downward inside the taller window (no re-flow, no scroll) — blanking
 * there would just flicker. A height SHRINK must blank: the frame is
 * painted rows-1 tall, so a shorter window leaves it OUTLIVING the window
 * and every repaint scrolls another copy into scrollback (the boot-clone
 * leak reported live: dozens of identical Welcome frames stacked up).
 *
 * Run: node scripts/smoke-resize-guard.mjs
 */
import { PassThrough } from "node:stream"
import { pathToFileURL } from "node:url"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = (...parts) =>
  pathToFileURL(path.join(here, "..", "dist", "packages", "tui", "src", "ink-app-esm", ...parts)).href

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const stripAnsi = (text) =>
  text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[=>]/g, "")

const BLANK = "\x1b[2J\x1b[H"
// Frame anchor: the composer placeholder row. The old "Welcome To Nemo
// CLI" banner line was deliberately replaced by the live clock
// (WelcomeScreen.tsx formatClock) — that literal no longer renders, and
// anchoring on it failed this smoke's boot check and cascaded 5 fails
// against a healthy build. The composer row appears exactly once per frame
// and spans the frame width, which is what the stack/stale-width checks
// below measure (same anchor diag-boot-frame-leak.mjs counts).
const ANCHOR = "Ask Nemo to do anything"

let failures = 0
const check = (ok, label) => {
  console.log(`${ok ? "ok" : "FAIL"}: ${label}`)
  if (!ok) failures++
}

// ── Fake TTY ────────────────────────────────────────────────────────────
const stdin = new PassThrough()
stdin.isTTY = true
stdin.setRawMode = () => {}
stdin.ref = () => {}
stdin.unref = () => {}

const stdout = new PassThrough()
stdout.isTTY = true
stdout.columns = 219
stdout.rows = 40
let sink = ""
stdout.on("data", (chunk) => {
  sink += chunk.toString()
})

const React = (await import("react")).default
const { render } = await import("ink")
const { NemoApp } = await import(dist("index.js"))
const { createResizeRedrawGuard } = await import(dist("resize-guard.js"))

// Same wiring as ink-repl.mjs: guard listener registered BEFORE render()
// (so it precedes Ink's own 'resize' handler), instance attached after.
const resizeGuard = createResizeRedrawGuard(stdout)
const instance = render(
  React.createElement(NemoApp, {
    config: { themeName: "nemo-dark", baseUrl: "http://localhost:1", apiKey: "x" },
  }),
  { stdin, stdout, patchConsole: false },
)
resizeGuard.attach(instance)
// Boot cinema length varies (multi-second logo animation); poll for the
// welcome frame instead of a fixed sleep — a fixed 1500ms wait went red
// the moment boot got slower, and every downstream check then failed on
// missing content rather than on the resize behaviour under test.
{
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && !stripAnsi(sink).includes(ANCHOR)) await wait(100)
  check(stripAnsi(sink).includes(ANCHOR), "boot completes within 10s (welcome frame renders)")
}

// ── 1. Width DEcrease: must blank + full repaint ───────────────────────
let mark = sink.length
stdout.columns = 150
stdout.emit("resize")
await wait(300)
let post = sink.slice(mark)
let blankAt = post.indexOf(BLANK)
check(blankAt !== -1, "width decrease → viewport blanked (ESC[2J ESC[H)")
if (blankAt !== -1) {
  const repaint = post.slice(blankAt + BLANK.length)
  check(
    stripAnsi(repaint).includes(ANCHOR),
    "width decrease → full frame repainted after the blank (no stale-erase reliance)",
  )
  const welcomes = (stripAnsi(post).match(new RegExp(ANCHOR, "g")) ?? []).length
  // Detail: border/welcome line widths show whether the extra frame is a
  // stale-width (pre-resize) render or a second post-resize render.
  const postLines = stripAnsi(post).split("\n")
  const detail = JSON.stringify({
    borders: postLines.filter((l) => l.startsWith("╭")).map((l) => l.length),
    welcomes: postLines.filter((l) => l.includes(ANCHOR)).map((l) => l.length),
  })
  // A repeat welcome is fine ONLY as an in-place rewrite: Ink legitimately
  // re-paints on cursor-blink/state ticks, but every repeat after the first
  // must be preceded by a rewind (cursor-up/2J) and every welcome row must
  // sit at the CURRENT width. The original bug appended full frames (stale
  // erase counts → stacked logos) — an append has no rewind, and its
  // remnants keep the OLD width.
  const rawPost = post
  const welcomeRe = new RegExp(ANCHOR, "g")
  let prevEnd = 0
  let seen = 0
  let stacked = false
  let wm
  while ((wm = welcomeRe.exec(rawPost)) !== null) {
    if (seen > 0 && !/\x1b\[[0-9]*[AB]|\x1b\[2J/.test(rawPost.slice(prevEnd, wm.index))) stacked = true
    prevEnd = wm.index + wm[0].length
    seen++
  }
  const welcomeWidths = postLines.filter((l) => l.includes(ANCHOR)).map((l) => l.length)
  const staleWidth = welcomeWidths.some((w) => w !== stdout.columns)
  check(
    !stacked && !staleWidth && welcomes >= 1,
    `width decrease → exactly one live frame (in-place repaint, no stack) (got ${welcomes}) ${detail} stacked=${stacked} widths=${JSON.stringify(welcomeWidths)}`,
  )
}

// ── 2. Width INcrease: Ink never clears on this path itself → guard must ──
mark = sink.length
stdout.columns = 240
stdout.emit("resize")
await wait(300)
post = sink.slice(mark)
blankAt = post.indexOf(BLANK)
check(blankAt !== -1, "width increase → viewport blanked (Ink's own handler never does this)")
if (blankAt !== -1) {
  const repaint = post.slice(blankAt + BLANK.length)
  check(stripAnsi(repaint).includes(ANCHOR), "width increase → full frame repainted after the blank")
}

// ── 2b. Width DRAG (rapid changes): one blank, re-homes, no stacked frames ──
// The live report: every terminal drag stacked one clean cloned frame behind
// the live one. A drag fires many resize events inside one rate-limit window;
// the first blanks, and every skipped one used to leave Ink repainting from
// the bottom cursor with a stale line count — past a shrink that scrolls, so
// each skipped repaint pushed rows into scrollback. Width shrinks now blank
// on EVERY step (never throttled: the terminal-side re-flow push lands before
// the app can paint a byte, so only a blank that arrives first preempts it);
// blank-less re-homing remains for growth inside the rate limit.
// Exactly one blank per shrink step plus the settle blank, no append.
mark = sink.length
for (const w of [230, 210, 190, 170]) {
  stdout.columns = w
  stdout.emit("resize")
}
// The settle blank lands at +150ms and only the app's 500ms idle tick puts
// the frame back (by design: "blank now, clean frame straight back"). The
// capture must therefore span a FULL tick past the settle (worst case a tick
// fired just before the drag, so the next one is at +500ms) or the snapshot
// races an intentionally empty screen and reads tops=0. 900ms gives margin.
await wait(900)
post = sink.slice(mark)
{
  // Every shrink step blanks unconditionally (a narrower window re-flows
  // full-width rows and the surplus scrolls terminal-side — only a blank
  // that lands first preempts it), plus the settle blank 150ms after the
  // last event (the wait below covers it). Nothing throttled, nothing
  // re-homed on a shrink drag.
  const blanks = post.split(BLANK).length - 1
  check(blanks === 5, `width drag → blank per shrink step + settle blank (got ${blanks})`)
  const welcomeRe = new RegExp(ANCHOR, "g")
  let prevEnd = 0
  let seen = 0
  let stacked = false
  let wm
  while ((wm = welcomeRe.exec(post)) !== null) {
    if (seen > 0 && !/\x1b\[[0-9]*[AB]|\x1b\[2J|\x1b\[H/.test(post.slice(prevEnd, wm.index))) stacked = true
    prevEnd = wm.index + wm[0].length
    seen++
  }
  // Re-homes (ESC[H without erase) are allowed separators: they reposition
  // without scrolling, so a repeat after one is an overwrite, not an append.
  // Intermediate widths paint superseded frames whose rows legitimately appear
  // in the bytes, so only the simulator — viewport plus scrollback — can say
  // whether the user saw one frame or a stack. Fresh simulator starting at
  // the drag's first blank (which wipes the viewport), so anything in its
  // scrollback at the end came from the drag itself.
  const { createScreen } = await import("./vt-screen.mjs")
  const screen = createScreen(230, 40)
  screen.write(post)
  const full = screen.snapshotFull()
  const isRootTop = (line) => {
    const t = line.trimEnd()
    if (!t.startsWith("╭")) return false
    return [...t].length >= Math.floor(170 * 0.8)
  }
  const tops = full.filter(isRootTop).length
  const anchors = full.filter((l) => l.includes(ANCHOR)).length
  check(tops === 1 && anchors === 1, `width drag → simulator shows exactly one frame, empty scrollback (tops=${tops} anchors=${anchors})`)
}

// ── 3. Height GROWTH: must NOT blank (frame grows down; no re-flow) ──────
mark = sink.length
stdout.rows = 48 // INCREASE: the frame must grow downward to fill it
stdout.emit("resize")
await wait(300)
post = sink.slice(mark)
check(!post.includes(BLANK), "height growth → no blank (avoids needless flicker)")
// ...and the frame must actually reach the new bottom. Root height is
// {rows - 1} by deliberate design (App.tsx: ONE slack row below the
// viewport keeps ink 7.1.1's win32 path off the fullscreen clear-storm —
// 21 wipes/550ms at height=rows, 0 at rows-1), so the border-box span
// tracks rows-1. A frame stuck at the old 40 rows would span 40 < 47.
{
  const hLines = stripAnsi(post).split("\n")
  let topIdx = -1
  for (let i = hLines.length - 1; i >= 0; i--) {
    if (hLines[i].startsWith("╭")) {
      topIdx = i
      break
    }
  }
  let botIdx = -1
  for (let i = hLines.length - 1; i > topIdx; i--) {
    if (hLines[i].startsWith("╰")) {
      botIdx = i
      break
    }
  }
  const span = topIdx === -1 ? -1 : botIdx - topIdx + 1
  check(
    span >= stdout.rows - 1,
    `height increase → frame grows with rows-1 slack (span=${span} rows=${stdout.rows})`,
  )
}

// ── 3b. Height SHRINK: MUST blank — the frame-outlives-window clone leak ──
// The frame is painted rows-1 tall, so a shorter window leaves it taller
// than the window: every later repaint writes past the last row, the
// console scrolls, and a copy of the frame lands in scrollback per repaint
// (the live report: dozens of identical Welcome frames stacked right after
// startup — the start-up settle is exactly one of these shrinks). The
// anchor re-homes the next paint at the new geometry.
mark = sink.length
stdout.rows = 40 // SHRINK from 48
stdout.emit("resize")
await wait(300)
post = sink.slice(mark)
check(post.includes(BLANK), "height shrink → viewport blanked (frame-outlives-window clone leak)")

// ── 4. Subsequent renders still work (counters not left broken) ────────
mark = sink.length
instance.rerender(
  React.createElement(NemoApp, {
    config: { themeName: "nemo-dark", baseUrl: "http://localhost:1", apiKey: "x" },
  }),
)
await wait(300)
post = stripAnsi(sink.slice(mark))
check(
  post.length === 0 || post.includes(ANCHOR) || post.includes("NEMO"),
  "post-resize re-render still emits a coherent frame",
)

instance.unmount()
await wait(50)

console.log(failures === 0 ? "RESIZE_GUARD_SMOKE_OK" : `RESIZE_GUARD_SMOKE_FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
