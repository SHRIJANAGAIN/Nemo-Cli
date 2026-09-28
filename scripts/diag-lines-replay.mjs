/* Lines-issue diagnostic: replay the REAL session behind the user's paste
 * (skt/8-conversations/sess_mugw35k9) through the full TrayambakApp in a
 * sandboxed TRAYAMBAK_HOME, feed every stdout byte into the VT100 screen
 * emulator, and dump the EXACT rows the user sees (scrollback + viewport).
 *
 * Why: the user's pasted transcript shows line-rendering problems ("SUNO
 * LINES FIX KARO") that no synthetic smoke reproduces — long model
 * paragraphs (383/829/1060 chars, \n\n-separated) + tool-call boxes + the
 * Static scrollback split. Byte-level smokes were green; this dumps the
 * user-visible screen for direct inspection and measures:
 *   M1: raw written lines longer than COLS (soft-wrap → erase desync)
 *   M2: tool-box row widths (must be uniform across the transcript)
 *   M3: "Called …" header rows missing the • bullet
 *   M4: no TRAYAMBAK header rows (header removed — branding = WelcomeScreen)
 *
 * Boot: the picker never auto-opens (first-screen boot) — this drives
 * /sessions to open it, then DOWN + Enter resumes the copied session
 * (same flow as smoke-resume-banner).
 *
 * Run: node scripts/diag-lines-replay.mjs            (COLS=120 ROWS=40 default)
 *      COLS=150 node scripts/diag-lines-replay.mjs
 */
import { PassThrough } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"
import fs from "node:fs"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, "..")
const distEsm = pathToFileURL(path.join(repo, "dist", "packages", "tui", "src", "ink-app-esm")).href

const COLS = Number(process.env.COLS || 120)
const ROWS = Number(process.env.ROWS || 40)

// ── Sandbox store seeded with the real session ─────────────────────────────
const sandbox = path.join("C:\\Users\\engli\\AppData\\Local\\Temp\\opencode", `trayambak-diag-lines-${COLS}`)
fs.rmSync(sandbox, { recursive: true, force: true })
const convDir = path.join(sandbox, "skt", "8-conversations")
fs.mkdirSync(convDir, { recursive: true })
fs.writeFileSync(path.join(sandbox, "package.json"), JSON.stringify({ name: "diag-lines" }))
// The fixture session lives in the store — or, after a factory reset, in the
// newest reset backup (the store itself is wiped to keep boot on the first
// screen; transcripts are preserved under backups/factory-reset-*).
const srcCandidates = [
  path.join(repo, "skt", "8-conversations", "sess_mugw35k9"),
  ...(fs.existsSync(path.join(repo, "backups"))
    ? fs
        .readdirSync(path.join(repo, "backups"), { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith("factory-reset-"))
        .sort((a, b) => b.name.localeCompare(a.name))
        .map((d) => path.join(repo, "backups", d.name, "8-conversations", "sess_mugw35k9"))
    : []),
]
const srcSession = srcCandidates.find((p) => fs.existsSync(p))
if (!srcSession) throw new Error("fixture sess_mugw35k9 not found in store or backups")
fs.cpSync(srcSession, path.join(convDir, "sess_mugw35k9"), { recursive: true })
// Boot does not surface it: /sessions opens the picker (see flow below).
fs.writeFileSync(
  path.join(convDir, "sessions.json"),
  JSON.stringify(
    [
      {
        sessionId: "sess_mugw35k9",
        sessionName: "Lines Diagnostic",
        sessionDescription: "",
        startedAt: "2026-09-25T10:00:00.000Z",
        messageCount: 0,
        totalTokens: 0,
        status: "active",
      },
    ],
    null,
    2,
  ),
)
process.env.TRAYAMBAK_HOME = sandbox

// ── Fake TTY + VT screen ───────────────────────────────────────────────────
const { createScreen } = await import("./vt-screen.mjs")
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
let raw = ""
const chunks = []
stdout.on("data", (chunk) => {
  const s = chunk.toString()
  raw += s
  chunks.push(s)
  screen.write(s)
})

const React = (await import("react")).default
const { render } = await import("ink")
const { TrayambakApp } = await import(`${distEsm}/index.js`)

const instance = render(
  React.createElement(TrayambakApp, {
    config: { themeName: "trayambak-dark", baseUrl: "http://127.0.0.1:9/api", apiKey: "k", model: "test/m", cwd: repo },
    modelName: "test/m",
    permissionMode: "ask",
    onExit: () => {},
  }),
  { stdin: sanitizedStdin, stdout, patchConsole: false },
)

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stdout.write(a.join(" ") + "\n")

await wait(1000)
log("── boot = first screen; opening picker via /sessions ──")
stdin.write("/sessions")
await wait(150)
stdin.write("\r")
await wait(500)
log("── picker open; selecting session ──")
stdin.write("\x1b[B")
await wait(200)
stdin.write("\r")
await wait(3500) // restore + Static flush + frames settle

// ── M1: raw written lines longer than COLS ─────────────────────────────────
const stripAnsi = (t) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
const rawLines = stripAnsi(raw)
  .split("\n")
  .map((l) => l.replace(/\r/g, ""))
const overlong = rawLines.filter((l) => l.length > COLS)
log(`M1 raw lines > ${COLS} cols: ${overlong.length}`)
overlong.slice(0, 5).forEach((l) => log(`  [${l.length}] ${JSON.stringify(l.slice(0, COLS))}…`))
if (overlong.length > 0) {
  // Which WRITE chunk carries it? Print the full (stripped) chunk plus the
  // previews of its neighbours — the surrounding writes identify the writer.
  const strip = (t) => stripAnsi(t).replace(/\r/g, "")
  let ci = -1
  let acc = ""
  let accLines = []
  for (let i = 0; i < chunks.length; i++) {
    acc += chunks[i]
    accLines = strip(acc).split("\n")
    if (accLines.some((l) => l.length > COLS)) {
      ci = i
      break
    }
  }
  if (ci === -1) {
    log("M1 (line spans chunk boundary — not localized)")
  } else {
    accLines.forEach((l, i) => {
      if (l.length > COLS) {
        log(
          `M1 acc overlong line #${i}/${accLines.length} len=${l.length} closeAt=${l.indexOf("┘")} hasDouble=${l.includes("┘└")}`,
        )
        log(`  head: ${JSON.stringify(l.slice(0, 60))}`)
        log(`  mid:  ${JSON.stringify(l.slice(110, 135))}`)
        log(`  tail: ${JSON.stringify(l.slice(-60))}`)
      }
    })
    for (let j = Math.max(0, ci - 3); j <= Math.min(chunks.length - 1, ci + 1); j++) {
      log(
        `  chunk #${j} (bytes=${chunks[j].length}) raw: ${JSON.stringify(chunks[j].length <= 40 ? chunks[j] : chunks[j].slice(0, 40))}`,
      )
    }
  }
}

// ── Dump what the user sees ────────────────────────────────────────────────
const rows = screen.snapshotFull()
const out = path.join(here, "..", ".smoke-tmp", `diag-lines-${COLS}.txt`)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, rows.map((r, i) => `${String(i).padStart(3, " ")}│${r}`).join("\n"))
log(`screen rows: ${rows.length} → ${out}`)

// ── M2: tool-box row widths ────────────────────────────────────────────────
const boxTops = rows.filter((r) => r.trimStart().startsWith("┌") || r.trimStart().startsWith("╭"))
const widths = new Map()
boxTops.forEach((r) => {
  const s = r.trimStart()
  widths.set(s.length, (widths.get(s.length) ?? 0) + 1)
})
log(
  `M2 tool-box top borders: ${boxTops.length}, width histogram: ` +
    [...widths.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([w, n]) => `${w}×${n}`)
      .join(" "),
)

// ── M3: Called-headers with/without bullet ─────────────────────────────────
const calledRows = rows.filter((r) => /│\s*[•●]?\s*Call(ed|ing) /.test(r))
const withBullet = calledRows.filter((r) => /│\s*[•●]\s*Call(ed|ing) /.test(r)).length
log(`M3 Called-headers: ${calledRows.length}, with • bullet: ${withBullet}, without: ${calledRows.length - withBullet}`)
calledRows
  .filter((r) => !/│\s*[•●]\s*Call(ed|ing) /.test(r))
  .slice(0, 6)
  .forEach((r) => log(`  no-bullet: ${JSON.stringify(r.slice(0, 90))}`))

// ── M4: TRAYAMBAK header rows ──────────────────────────────────────────────
// The compact logo header (+ its padding row) was removed from the chat
// frame — it burned 2 rows/transcript. A resumed transcript must therefore
// contain ZERO rows carrying "TRAYAMBAK" (branding stays on the WelcomeScreen
// empty state and the ThemePicker only).
const logoRows = rows.filter((r) => r.includes("TRAYAMBAK"))
log(
  `M4 TRAYAMBAK rows in frame: ${logoRows.length} (want 0) ${logoRows.length === 0 ? "ok" : "BAD — header still rendered"}`,
)
logoRows.forEach((r) => log(`  present: ${JSON.stringify(r.slice(0, 90))}`))

instance.unmount()
await wait(100)
log("DIAG_DONE")
process.exit(0)
