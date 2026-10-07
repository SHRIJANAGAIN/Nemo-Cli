/* Screen-replay smoke: replays the app's raw byte stream through a mini VT100
 * emulator and asserts the FINAL/ongoing SCREEN state (not the byte stream).
 *
 * Why: byte-level checks proved clean (every fullscreen frame is a full
 * clear+rewrite), yet the user sees a stuck row:
 *   │TRAYAMBAK        { REMOVE } THIS TEXT FROM BOX FIX IT //// …
 * i.e. the logo row merged with a message row on SCREEN. That can only be
 * caught by modelling cursor/erase/wrap semantics across all write paths
 * (frame writes, static flush, console.log→writeToStdout, resize-guard blank).
 *
 * Scenarios: submit messages (long + wrapping), slash-menu open/navigate/
 * shrink (concurrent editor's "stale tail" repro), console.log mid-session
 * (notify path), width resize (guard path), more submits.
 *
 * Oracles (checked after every settle, over scrollback + viewport):
 *   O1: every row containing TRAYAMBAK matches  │TRAYAMBAK<spaces>│
 *   O2: no row contains TRAYAMBAK together with a submitted marker
 *   O3: no row contains two distinct markers (cross-row merge)
 *   O4: viewport top row is the frame's ┌ border (no off-by-one scroll)
 *
 * Run: node scripts/smoke-screen-replay.mjs
 */
import { PassThrough } from "node:stream"
import { writeFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const distEsm = pathToFileURL(path.join(here, "..", "dist", "packages", "tui", "src", "ink-app-esm")).href

// Log via fs.writeSync — Ink patchConsole hijacks console.* during the run.
const log = (...a) => process.stdout.write(a.join(" ") + "\n")

const COLS = Number(process.env.SR_COLS || 76)
const ROWS = Number(process.env.SR_ROWS || 40)

const { createScreen } = await import("./vt-screen.mjs")

/* ── Oracles ─────────────────────────────────────────────────────────────── */
const MARKERS = [
  "MARKER_ALPHA_ONE",
  "MARKER_BRAVO_TWO",
  "MARKER_CHARLIE_THREE",
  "MARKER_DELTA_LONG",
  "NOTIFY_MARKER_ZULU",
  "MARKER_FILLER",
]
let failures = 0
const checkScreen = (screen, label) => {
  const rows = screen.snapshotFull()
  let ok = true
  const reasons = []
  const sbLen = screen.scrollbackRows().length
  rows.forEach((r, i) => {
    const where = i < sbLen ? `sb${i}` : `row${i - sbLen}`
    if (r.includes("TRAYAMBAK")) {
      if (!/^│TRAYAMBAK\s*│$/.test(r)) {
        ok = false
        reasons.push(`O1 ${where}: ${JSON.stringify(r)}`)
      }
      for (const m of MARKERS)
        if (r.includes(m)) {
          ok = false
          reasons.push(`O2 ${where}: logo+${m}`)
        }
    }
    const here = MARKERS.filter((m) => r.includes(m))
    if (here.length > 1) {
      ok = false
      reasons.push(`O3 ${where}: ${here.join("+")}`)
    }
  })
  // O4: the frame fills the viewport exactly — top row = a box OPENING
  // row, bottom row = its bottom cap. Fresh sessions open with the
  // rounded ╭ cap; once the bordered scrollback prefix exists the root
  // drops its top border, so the first row is the frame's │ wall
  // continuing the segment above. A trailing-\n write that shifts the
  // frame down loses the ╰ cap at the bottom (O4b) — and any row that
  // is neither opening form fails O4.
  const vp = screen.snapshot()
  const top = vp[0] ?? ""
  const bottom = vp[vp.length - 1] ?? ""
  const topOk = top.startsWith("╭") || (top.startsWith("│") && top.trimEnd().endsWith("│"))
  if (!topOk) {
    ok = false
    reasons.push(`O4: viewport top = ${JSON.stringify(top)}`)
  }
  // O4b: the frame's bottom cap must anchor the viewport. The root Box is
  // deliberately `height={rows-1}` (App.tsx win32 fix: a full-height frame
  // trips Ink's wipe+reprint), so the cap sits at rows-2 and the last row is
  // a blank slack row — accept exactly that shape, nothing looser.
  const slack = bottom.trim() === ""
  const capAbove = (vp[vp.length - 2] ?? "").startsWith("╰")
  if (!bottom.startsWith("╰") && !(slack && capAbove)) {
    ok = false
    reasons.push(`O4b: viewport bottom = ${JSON.stringify(bottom)}`)
  }
  log(`${ok ? "ok" : "FAIL"}: ${label}${ok ? "" : "\n  " + reasons.join("\n  ")}`)
  if (!ok) {
    failures++
    dumpScreen(screen, `VIOLATION @ ${label}`)
  }
  return ok
}
const dumpScreen = (screen, title) => {
  const sb = screen.scrollbackRows()
  log(`── screen dump: ${title} ──`)
  sb.forEach((r, i) => log(`~${String(i).padStart(2, " ")}│${r}`))
  if (sb.length > 0) log("  ··· viewport below ···")
  screen.snapshot().forEach((r, i) => log(`${String(i).padStart(2, " ")}│${r}`))
  log("── end dump ──")
}

/* ── Fake TTY + app boot ─────────────────────────────────────────────────── */
const stdin = new PassThrough()
stdin.isTTY = true
stdin.setRawMode = () => {}
stdin.ref = () => {}
stdin.unref = () => {}

const { createSanitizedStdin } = await import(`${distEsm}/stdin-sanitizer.js`)
const sanitizedStdin = createSanitizedStdin(stdin)

const stdout = new PassThrough()
stdout.isTTY = true
stdout.columns = COLS
stdout.rows = ROWS

const screen = createScreen(COLS, ROWS)
stdout.on("data", (chunk) => screen.write(chunk.toString()))

const React = (await import("react")).default
const { render } = await import("ink")
const { TrayambakApp } = await import(`${distEsm}/index.js`)

const instance = render(
  React.createElement(TrayambakApp, {
    config: {
      themeName: "trayambak-dark",
      baseUrl: "http://127.0.0.1:9/api",
      apiKey: "k",
      model: "test/m",
      cwd: process.cwd(),
    },
    modelName: "test/m",
    permissionMode: "ask",
    onExit: () => {},
  }),
  { stdin: sanitizedStdin, stdout },
)

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const settle = async (ms = 700) => {
  await wait(ms)
  checkScreen(screen, current)
}
let current = "boot"

current = "boot"
await settle(900)

// ── Scenario 1: submit short marker ────────────────────────────────────────
current = "submit-MARKER_ALPHA_ONE"
stdin.write("MARKER_ALPHA_ONE")
await wait(150)
stdin.write("\r")
await settle(1400)

// ── Scenario 2: long wrapping message ──────────────────────────────────────
current = "submit-MARKER_DELTA_LONG (wraps)"
const longMsg =
  "MARKER_DELTA_LONG " + "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ".repeat(3)
stdin.write(longMsg)
await wait(250)
stdin.write("\r")
await settle(1600)

// ── Scenario 3: third message (pushes static split) ────────────────────────
current = "submit-MARKER_BRAVO_TWO (static flush)"
stdin.write("MARKER_BRAVO_TWO")
await wait(150)
stdin.write("\r")
await settle(1600)

// ── Scenario 3b: transcript rows must live INSIDE a box ────────────────────
// rowBudget = rows-9; short messages ≈2-3 rows each → the budget overflows
// and the stable prefix evicts into scrollback. It may only do so as
// BORDERED segments (│ … │ on every line, ┌ cap on the very first row):
// wheel-up then shows old history INSIDE the conversation box's
// continuation — reachable, never hidden. What must NEVER happen is a
// NAKED transcript line anywhere on screen (the "box ke bahar" state of
// the user's screenshot — borderless text floating over/above the box).
// Oracle: every MARKER_FILLER row starts AND ends with a box edge, and the
// evicted prefix actually reached scrollback (history present, not gone).
current = "force-static-split"
for (let i = 0; i < 18; i++) {
  stdin.write(`MARKER_FILLER_N${i} filler line to build transcript bulk before the frame budget overflows`)
  await wait(90)
  stdin.write("\r")
  await wait(450)
  if (i % 6 === 5) checkScreen(screen, `force-static-split @${i + 1}`)
}
await settle(1500)
{
  const fillerRows = screen.snapshotFull().filter((r) => r.includes("MARKER_FILLER"))
  const inScrollback = screen.scrollbackRows().filter((r) => r.includes("MARKER_FILLER"))
  const isBoxed = (r) => {
    const t = r.trimEnd()
    return (
      (r.startsWith("│") || r.startsWith("┌") || r.startsWith("╭")) &&
      (t.endsWith("│") || t.endsWith("┐") || t.endsWith("╮"))
    )
  }
  const naked = fillerRows.filter((r) => !isBoxed(r))
  // With the prefix confirmed in scrollback, the root frame MUST have
  // dropped its top border: a corner-capped row (╭────╮ / ┌────┐) at
  // viewport top is the old divider slicing the transcript between prefix
  // and live tail — the line the user pointed at ("ye line … must hide").
  const vpTop = screen.snapshot()[0] ?? ""
  const dividerGone = !vpTop.startsWith("╭") && !vpTop.startsWith("┌")
  const ok = inScrollback.length > 0 && naked.length === 0 && dividerGone
  log(
    `${ok ? "ok" : "FAIL"}: boxed-transcript (scrollbackFiller=${inScrollback.length}, naked=${naked.length}, dividerGone=${dividerGone})`,
  )
  if (!ok) {
    failures++
    dumpScreen(screen, `naked=${naked.length} vpTop=${JSON.stringify(vpTop.slice(0, 20))}`)
  }
}

// ── Scenario 4: slash menu open → navigate → shrink (stale-tail repro) ─────
current = "slash-menu-open"
stdin.write("/")
await settle(500)
current = "slash-menu-navigate-down"
stdin.write("\x1b[B")
await wait(200)
stdin.write("\x1b[B")
await settle(500)
current = "slash-menu-navigate-up"
stdin.write("\x1b[A")
await settle(500)
current = "slash-menu-shrink"
stdin.write("\x7f") // backspace: "/" → "" closes menu
await settle(700)

// ── Scenario 5: console.log mid-session (notify-user path) ─────────────────
current = "console-log-notify"
console.log("[trayambak notify][info] NOTIFY_MARKER_ZULU happened")
await settle(900)

// ── Scenario 6: width resize (guard path) ──────────────────────────────────
current = "resize-76-to-90"
stdout.columns = 90
screen.resizeTo(90, ROWS)
stdout.emit("resize")
await settle(900)
current = "resize-90-to-76"
stdout.columns = COLS
screen.resizeTo(COLS, ROWS)
stdout.emit("resize")
await settle(900)

// ── Scenario 7: submit after resize (static flush + resized frame) ─────────
current = "submit-MARKER_CHARLIE_THREE-after-resize"
stdin.write("MARKER_CHARLIE_THREE")
await wait(150)
stdin.write("\r")
await settle(1600)

// ── Scenario 8: height-only resize (guard must NOT blank; frame height chg) ─
current = "resize-height-40-to-44"
stdout.rows = 44
screen.resizeTo(COLS, 44)
stdout.emit("resize")
await settle(900)
current = "resize-height-44-to-40"
stdout.rows = ROWS
screen.resizeTo(COLS, ROWS)
stdout.emit("resize")
await settle(900)

current = "final"
checkScreen(screen, "final state")
dumpScreen(screen, "final")

writeFileSync(
  path.join(here, "smoke-screen-replay.result.txt"),
  (failures === 0 ? "SCREEN_REPLAY_OK\n" : `SCREEN_REPLAY_FAIL:${failures}\n`) + screen.snapshotFull().join("\n"),
)

instance.unmount()
await wait(100)
log(failures === 0 ? "SCREEN_REPLAY_OK" : `SCREEN_REPLAY_FAIL:${failures}`)
process.exit(failures === 0 ? 0 : 1)
