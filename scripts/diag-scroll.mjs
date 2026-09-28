/* Scrollability diagnostic v3 — "puri tarah se scrollable ho, ye sahi nahi
 * check". Drives the BUILT TrayambakApp on fake TTY ends with the EXACT
 * byte sequences a real terminal sends and measures what the frame shows.
 *
 * v3 changes over v2 (lessons from the first runs):
 *   - ALL diagnostics go through appendFileSync → immune to the stdout
 *     truncation process.exit() causes on Windows (v2 lost every "ok:"
 *     and frame dump — only stderr survived).
 *   - turn completion = footer "idle" STABLE across two pokes with the
 *     marker in-frame (v2's error-row COUNTS lied: the phrase appears
 *     ~5× per error message).
 *   - next prompt only sent when idle-stable → the prompt queue can never
 *     race the test (v2's MSG03 vanished — v3 proves via the SUBMIT line
 *     in the input log whether the draft even reached handleInput).
 *
 * Phases:
 *   boot → dismiss overlays → turn1 (MSG01) → idle-stable → turn2 (MSG02)
 *   A  live sanity            → both markers + errors present
 *   B  wheel-UP ×1 at IDLE    → newest hidden, older visible
 *   C  wheel-DOWN ×1          → live again
 *   D  PageUp / E  PageDown   → keys slide + return
 *   B2 wheel-UP ×10           → TOP = exactly the first message
 *   C2 wheel-DOWN ×12         → live again
 *   F  idle-stable → send MSG03 → SUBMIT probe → catch busy footer →
 *      wheel ×2 → S_before mid-turn → S_after after turn end →
 *      position must persist (no snap-back, no drift toward live)
 *   G  wheel-down storm       → live shows MSG03 (turn really ran)
 *
 * Run: node scripts/diag-scroll.mjs   (after npm run build). Redirect
 *      stdout freely — the full record always lands in the FILE log below
 *      (process.exit truncates piped stdout on Windows).
 */
import { PassThrough } from "node:stream"
import { readFileSync, unlinkSync, appendFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import path from "node:path"

process.env.TRAYAMBAK_DEBUG_INPUT = "1"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, "..")
// Resolved BEFORE TEMP is pointed at .smoke-tmp below → OS temp, not the
// repo (other diag-* scripts print to console only; no repo litter).
const diagFile = path.join(tmpdir(), "trayambak-diag-scroll.log")
try {
  unlinkSync(diagFile)
} catch {
  /* fresh log */
}
console.log(`[diag] file log: ${diagFile}`)
const t0 = Date.now()
/** Sync file log — survives process.exit on Windows (stdout does not). */
function dlog(msg) {
  const line = `[t+${String(Date.now() - t0).padStart(6)}ms] ${msg}`
  console.log(line)
  try {
    appendFileSync(diagFile, `${line}\n`)
  } catch {
    /* best effort */
  }
}

process.env.TEMP = path.join(repo, ".smoke-tmp")
try {
  ;(await import("node:fs")).mkdirSync(process.env.TEMP, { recursive: true })
} catch {
  /* best effort */
}
process.env.TRAYAMBAK_LOGO_PATH = pathToFileURL(
  path.join(repo, "dist", "packages", "tui", "src", "ink-app-esm", "logo_ansi.txt"),
).href

// Hermetic sessions (same sandbox as smoke-app-send).
let sandboxHome = ""
{
  const fsMem = await import("node:fs")
  sandboxHome = fsMem.mkdtempSync(path.join(tmpdir(), "trayambak-scroll-"))
  const convDir = path.join(sandboxHome, "skt", "8-conversations")
  fsMem.mkdirSync(convDir, { recursive: true })
  fsMem.writeFileSync(path.join(sandboxHome, "package.json"), JSON.stringify({ name: "scroll-diag" }))
  fsMem.writeFileSync(path.join(convDir, "sessions.json"), "[]")
  process.env.TRAYAMBAK_HOME = sandboxHome
}
dlog(`TRAYAMBAK_HOME = ${sandboxHome}`)

const logPath = path.join(tmpdir(), "trayambak-input.log")
try {
  unlinkSync(logPath)
} catch {
  /* first run */
}

process.on("uncaughtException", (error) => {
  dlog(`[uncaughtException] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
})
process.on("unhandledRejection", (error) => {
  dlog(`[unhandledRejection] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
})

// ── Fake TTY ends ───────────────────────────────────────────────────────
const stdin = new PassThrough()
stdin.isTTY = true
stdin.setRawMode = () => {}
stdin.ref = () => {}
stdin.unref = () => {}

const { createSanitizedStdin } = await import(
  pathToFileURL(path.join(repo, "dist", "packages", "tui", "src", "ink-app-esm", "stdin-sanitizer.js")).href
)
const sanitizedStdin = createSanitizedStdin(stdin)

const stdout = new PassThrough()
stdout.isTTY = true
stdout.columns = 140
stdout.rows = 40
let sink = ""
stdout.on("data", (chunk) => {
  sink += chunk.toString()
})

const React = (await import("react")).default
const { render } = await import("ink")
const { TrayambakApp } = await import(
  pathToFileURL(path.join(repo, "dist", "packages", "tui", "src", "ink-app-esm", "index.js")).href
)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const readLog = () => {
  try {
    return readFileSync(logPath, "utf8")
  } catch {
    return ""
  }
}
const stripAnsi = (text) =>
  text.replace(/\x1b\][0-9;]*[^\x07]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

const WHEEL_UP = "\x1b[<64;10;10M"
const WHEEL_DOWN = "\x1b[<65;10;10M"
const PAGE_UP = "\x1b[5~"
const PAGE_DOWN = "\x1b[6~"

let failures = 0
function assert(cond, label, detail = "") {
  if (cond) {
    dlog(`ok: ${label}`)
  } else {
    failures += 1
    dlog(`FAIL: ${label}${detail ? ` | ${detail}` : ""}`)
  }
}

const errRows = (s) => (s.match(/model\/connection error/g) || []).length
/** A fresh sink holds ~1-5 concatenated full-frame reprints (caret blink /
 *  spinner repaint). Partial frames at a clear boundary make raw counts
 *  flaky, so window-content checks use the LAST COMPLETE frame only
 *  (splits on the box's top border; a full 40×140 frame is >2000 chars). */
function lastFrame(s) {
  const parts = s.split(/╭─{8,}/)
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i].length > 2000) return parts[i]
  }
  return s
}
function markers(t) {
  return {
    m1: t.includes("MSG01"),
    m2: t.includes("MSG02"),
    m3: t.includes("MSG03"),
    err: errRows(t),
    busy: /\b(thinking|running)\b/.test(t),
    idle: /\bidle\b/.test(t),
    queued: /Queued \(/.test(t),
  }
}
const fp = (t) => JSON.stringify(markers(t))
const composerLine = (t) => (t.match(/❯[^\n]*/) || [""])[0].slice(0, 120)

/** Force a render of the CURRENT state (x + backspace leaves the draft
 *  untouched) and return only that fresh frame's text. */
async function snapshot(label) {
  sink = ""
  stdin.write("x")
  await wait(120)
  stdin.write("\x7f")
  await wait(420)
  const fresh = stripAnsi(sink)
  dlog(`${label} markers=${fp(fresh)} composer=${JSON.stringify(composerLine(fresh))}`)
  // WHERE does the error text sit? line index within the frame tells
  // window-content (top) apart from footer/status (bottom).
  const allLines = fresh.split("\n")
  let errShown = 0
  allLines.forEach((ln, i) => {
    if (ln.includes("model/connection error") && errShown < 8) {
      dlog(`${label} errline[${i}/${allLines.length}]: ${JSON.stringify(ln.trim().slice(0, 140))}`)
      errShown += 1
    }
  })
  dlog(`${label} tail: ${JSON.stringify(allLines.slice(-8).map((l) => l.trim().slice(0, 100)))}`)
  dlog(`${label} frame=${JSON.stringify(fresh.slice(0, 12000))}`)
  return fresh
}

/** One poke-render without the heavy dump (loop iterations). */
async function poke() {
  sink = ""
  stdin.write("x")
  await wait(80)
  stdin.write("\x7f")
  await wait(220)
  return stripAnsi(sink)
}

async function waitSubmit(value, ms) {
  const needle = `SUBMIT value=${JSON.stringify(value)}`
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (readLog().includes(needle)) return true
    await wait(150)
  }
  return false
}

/** Turn completion: footer idle STABLE across two pokes, marker in-frame.
 *  (Error-row counts lie — the phrase repeats inside one message.) */
async function waitIdleStable(marker, ms) {
  const start = Date.now()
  let streak = 0
  let last = ""
  while (Date.now() - start < ms) {
    const f = await poke()
    last = f
    const st = markers(f)
    const good = !st.busy && st.idle && f.includes(marker)
    streak = good ? streak + 1 : 0
    if (streak >= 2) return f
    await wait(120)
  }
  dlog(`waitIdleStable(${marker}) TIMEOUT; last=${fp(last)}`)
  return null
}

// ── Boot ────────────────────────────────────────────────────────────────
const instance = render(
  React.createElement(TrayambakApp, {
    config: { themeName: "trayambak-dark" },
    modelName: "smoke-model",
    permissionMode: "ask",
  }),
  { stdin: sanitizedStdin, stdout },
)

await wait(1800)
const bootSink = sink
assert(bootSink.includes("\x1b[?1000h") && bootSink.includes("\x1b[?1006h"), "mouse reporting ON at boot")

stdin.write("\x1b")
await wait(350)
stdin.write("\x1b")
await wait(400)

async function sendPrompt(text) {
  stdin.write(`${text}\r`)
}

// ── Turn 1 ──────────────────────────────────────────────────────────────
await sendPrompt("MSG01")
assert(await waitSubmit("MSG01", 6000), "SUBMIT MSG01 reached handleInput")
assert((await waitIdleStable("MSG01", 120000)) !== null, "turn 1 finished (idle-stable, MSG01 in frame)")

// ── Turn 2 (sent only when idle → no queue) ─────────────────────────────
await sendPrompt("MSG02")
assert(await waitSubmit("MSG02", 6000), "SUBMIT MSG02 reached handleInput")
assert((await waitIdleStable("MSG02", 120000)) !== null, "turn 2 finished (idle-stable, MSG02 in frame)")

// A — live sanity
const live1 = await snapshot("A live")
assert(
  live1.includes("MSG01") && live1.includes("MSG02") && errRows(live1) >= 1,
  "live frame shows both messages + error rows",
  fp(live1),
)

// B — wheel-UP ×1 at IDLE
stdin.write(WHEEL_UP)
await wait(400)
const up1 = await snapshot("B wheel-up x1 at idle")
assert(!up1.includes("MSG02"), "wheel-up ×1 at IDLE hides the newest message", fp(up1))
assert(up1.includes("MSG01"), "wheel-up ×1 at IDLE keeps older messages visible", fp(up1))
assert(
  errRows(up1) < errRows(live1),
  `wheel-up ×1 scrolled past an error row (${errRows(live1)}→${errRows(up1)})`,
  fp(up1),
)

// C — wheel-DOWN ×1 back to live
stdin.write(WHEEL_DOWN)
await wait(400)
const down1 = await snapshot("C wheel-down x1")
assert(down1.includes("MSG02"), "wheel-down ×1 returns to live", fp(down1))

// D — PageUp
stdin.write(PAGE_UP)
await wait(400)
const pg1 = await snapshot("D PageUp")
assert(!pg1.includes("MSG02"), "PageUp slides the window (newest hidden)", fp(pg1))

// E — PageDown back to live
stdin.write(PAGE_DOWN)
await wait(400)
const pg2 = await snapshot("E PageDown")
assert(pg2.includes("MSG02"), "PageDown returns to live", fp(pg2))

// B2 — wheel-UP ×10: clamps at message 0 (the TOP must be reachable).
for (let i = 0; i < 10; i += 1) stdin.write(WHEEL_UP)
await wait(600)
const top = await snapshot("B2 wheel-up x10 (top)")
assert(!top.includes("MSG02"), "TOP reached: newest message gone after 10 notches", fp(top))
assert(top.includes("MSG01"), "TOP reached: first message (MSG01) visible", fp(top))
assert(errRows(top) === 0, "TOP reached: window is exactly the first message", fp(top))

// C2 — wheel-DOWN ×12 back to live
for (let i = 0; i < 12; i += 1) stdin.write(WHEEL_DOWN)
await wait(600)
const backLive1 = await snapshot("C2 wheel-down x12")
assert(backLive1.includes("MSG02"), "wheel-down storm returns to live", fp(backLive1))

// F — persistence across turn end (idle-stable precondition → MSG03 can
// neither queue nor race a lingering turn).
const idlePre = await waitIdleStable("MSG02", 30000)
assert(idlePre !== null, "F precondition: idle-stable before MSG03")
await sendPrompt("MSG03")
const submit3 = await waitSubmit("MSG03", 6000)
assert(submit3, "SUBMIT MSG03 reached handleInput", submit3 ? "" : "input log has no SUBMIT for MSG03")

let S_before = null
let S_after = null
let wheeled = false
let sawBusy = false
let nonBusyStreak = 0
let wheelNote = ""
if (!submit3) {
  // Input never reached handleInput — skip the busy dance, go straight to
  // the weak path so G still reports the transcript's true state.
  stdin.write(WHEEL_UP + WHEEL_UP)
  S_before = await snapshot("F weak (no SUBMIT)")
  S_after = await snapshot("F weak after")
  wheelNote = "weak: no SUBMIT line for MSG03"
} else {
  for (let i = 0; i < 400 && !S_after; i += 1) {
    const fresh = await poke()
    const st = markers(fresh)
    if (st.busy) {
      sawBusy = true
      nonBusyStreak = 0
      if (!wheeled) {
        stdin.write(WHEEL_UP + WHEEL_UP)
        wheeled = true
        wheelNote = `wheel ×2 mid-turn at iter ${i}`
        await wait(150)
        const mid = await snapshot("F mid-turn after wheel")
        if (markers(mid).busy) {
          S_before = mid
          wheelNote += " [S_before mid-turn]"
        } else {
          wheelNote += " [turn ended during S_before]"
        }
      }
    } else if (S_before) {
      nonBusyStreak += 1
      if (nonBusyStreak >= 2) {
        await wait(300)
        S_after = await snapshot("F after turn end")
        break
      }
    } else if (i === 60) {
      stdin.write(WHEEL_UP + WHEEL_UP)
      wheeled = true
      wheelNote = "weak: busy window missed (turn too fast?)"
      S_before = await snapshot("F (no busy seen)")
      S_after = await snapshot("F after turn end (weak)")
      break
    }
  }
}
dlog(`F: ${wheelNote || "never wheeled"} sawBusy=${sawBusy}`)
if (S_before) dlog(`F S_before markers=${fp(S_before)}`)
if (S_after) dlog(`F S_after  markers=${fp(S_after)}`)

assert(
  sawBusy && Boolean(S_before && wheelNote.includes("mid-turn")),
  "caught the turn busy and wheeled mid-turn",
  wheelNote,
)
if (S_before) {
  assert(!markers(S_before).m3, "scrolled up DURING the turn (MSG03 out of frame)", fp(S_before))
  // Double-notch from 0 with count=5 must clamp at endIdx=1 → LAST frame is
  // EXACTLY [MSG01] (no error rows). err>0 in the last frame = a notch got
  // eaten (an intermediate one-notch paint only shows in earlier frames).
  assert(errRows(lastFrame(S_before)) === 0, "wheel ×2 in one burst lands at endIdx=1 (window = [MSG01])", fp(S_before))
}
if (S_before && S_after) {
  assert(!markers(S_after).m3, "position PERSISTED across turn end (MSG03 still out of frame)", fp(S_after))
  // Growth anchor: turn end appended e3 (count 5→6) — the window must stay
  // pinned at endIdx=1 (last frame = [MSG01], err=0). err>0 = the offset
  // didn't grow with the count and the reading position slid toward live.
  assert(errRows(lastFrame(S_after)) === 0, "growth anchor held across turn end (window still [MSG01])", fp(S_after))
  const b = markers(S_before)
  const a = markers(S_after)
  assert(
    (b.m1 || !a.m1) && (b.m2 || !a.m2),
    "no drift toward live after turn end (S_after ⊆ S_before markers)",
    JSON.stringify({ before: b, after: a }),
  )
}

// G — wheel-down storm reaches live again (MSG03 must be visible: SUBMIT
// proved the draft arrived, so if this fails the queue/run path lost it).
for (let i = 0; i < 12; i += 1) stdin.write(WHEEL_DOWN)
await wait(600)
const backLive = await snapshot("G wheel-down storm")
assert(
  backLive.includes("MSG03") && !markers(backLive).queued,
  "wheel-down storm returns to live and shows MSG03 (no queue residue)",
  fp(backLive),
)

// Wheel bytes really ARRIVED (sanitizer parsed them), not just sent.
const log = readLog()
const mouseRaw = (log.match(/MOUSE-RAW/g) || []).length
assert(mouseRaw >= 10, `wheel bytes arrived and parsed (MOUSE-RAW ×${mouseRaw} ≥ 10)`)

// Forensics: every SUBMIT + every MOUSE-RAW line (timestamped — shows
// exactly how many wheel events arrived per burst).
const submits = log.match(/SUBMIT value=[^\n]*/g) || []
dlog(`input-log SUBMITs: ${JSON.stringify(submits)}`)
const piLines = log
  .split(/\r?\n/)
  .filter((l) => l.includes("MSG0"))
  .slice(0, 30)
dlog(`input-log MSG lines: ${JSON.stringify(piLines)}`)
const mouseLines = log.split(/\r?\n/).filter((l) => l.includes("MOUSE-RAW"))
dlog(`input-log MOUSE-RAW (${mouseLines.length}): ${JSON.stringify(mouseLines)}`)

instance.unmount()
await wait(80)
dlog(failures === 0 ? "DIAG_SCROLL_OK" : `DIAG_SCROLL_FAIL ${failures}`)
process.exit(failures === 0 ? 0 : 1)
