/* Login-wizard hide E2E — "wizard prompts cancelled/completed hone to gayab
 * ho jayein": the transcript used to keep every connect step's prompt row
 * forever (ttlMs: 0 = "must stay on screen" with no exit, and
 * "Provider connect cancelled." had no TTL at all — the exact box in the bug
 * report: Choose a provider + enter Base URL + cancelled, all still there).
 *
 * Renders the BUILT TrayambakApp on fake TTY stdin/stdout and drives it like
 * a user:
 *
 *   boot → dismiss overlays → /provider (bare) → provider picker opens
 *     1. type 8 (Custom endpoint, needsBaseUrl) → base-URL prompt appears AND
 *        "Choose a provider" is GONE            (step completed → hide;
 *        pre-fix both rows stacked in the transcript — the bug box)
 *     2. Esc → "Provider connect cancelled." appears AND base-URL prompt is
 *        GONE                                   (cancelled → hide)
 *     3. wait out the 10s outcome TTL → cancelled line also gone
 *        (every wizard row eventually gayab)
 *
 * Run: node scripts/smoke-login-hide.mjs   (after npm run build)
 */
import { PassThrough } from "node:stream"
import { readFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, "..")
process.env.TEMP = path.join(repo, ".smoke-tmp")
try {
  ;(await import("node:fs")).mkdirSync(process.env.TEMP, { recursive: true })
} catch {
  /* best effort */
}
process.env.TRAYAMBAK_LOGO_PATH = pathToFileURL(
  path.join(repo, "dist", "packages", "tui", "src", "ink-app-esm", "logo_ansi.txt"),
).href

// Session hermeticity (same sandbox as smoke-app-send): a fresh
// TRAYAMBAK_HOME keeps real sessions out of the run and starts with an
// empty picker state.
{
  const fsMem = await import("node:fs")
  const sandbox = fsMem.mkdtempSync(path.join(tmpdir(), "trayambak-loginhide-"))
  const convDir = path.join(sandbox, "skt", "8-conversations")
  fsMem.mkdirSync(convDir, { recursive: true })
  fsMem.writeFileSync(path.join(sandbox, "package.json"), JSON.stringify({ name: "login-hide-smoke" }))
  fsMem.writeFileSync(path.join(convDir, "sessions.json"), "[]")
  process.env.TRAYAMBAK_HOME = sandbox
}

// Hard-fail policy: log and exit non-zero immediately — a logged-but-alive
// handler turns a mid-run failure into an infinite hang (see devmode smoke).
process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error)
  process.exit(1)
})
process.on("unhandledRejection", (error) => {
  console.error("[unhandledRejection]", error)
  process.exit(1)
})

// ── Fake TTY ends ────────────────────────────────────────────────────────
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
const stripAnsi = (text) =>
  text
    .replace(/\x1b\][0-9;]*[^\x07]*(\x07|\x1b\\)/g, "") // OSC
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "") // CSI

/** Latest complete frame: everything after the last full-screen clear (each
 *  win32 viewport-filling write takes the clearTerminal path), falling back
 *  to the whole post-reset sink when no clear landed yet. */
const latestFrame = () => {
  const i = sink.lastIndexOf("\x1b[2J")
  return stripAnsi(i >= 0 ? sink.slice(i) : sink)
}

/** Reset, run an action, and poll the frame for a substring. */
async function capture(action, needle, tries = 30) {
  sink = ""
  if (action) await action()
  for (let i = 0; i < tries; i += 1) {
    await wait(150)
    const frame = latestFrame()
    if (needle === null || frame.includes(needle)) return frame
  }
  return latestFrame()
}

let failures = 0
function assert(cond, label, detail = "") {
  if (cond) {
    console.log("ok:", label)
  } else {
    failures += 1
    console.error("FAIL:", label)
    if (detail) console.error(detail)
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────
const instance = render(
  React.createElement(TrayambakApp, {
    config: { themeName: "trayambak-dark" },
    modelName: "smoke-model",
    permissionMode: "ask",
  }),
  { stdin: sanitizedStdin, stdout },
)

await wait(1800)

// Dismiss boot overlays (same two-step as smoke-app-send; with an empty
// session list the second Esc is a harmless composer clear).
stdin.write("\x1b")
await wait(350)
stdin.write("\x1b")
await wait(400)

// ── Step 0: open the wizard ──────────────────────────────────────────────
// The provider picker replaces the transcript while open (ternary render),
// so the proof that startLogin ran is the picker itself; the prompt row
// renders only once an overlay closes.
const openFrame = await capture(async () => {
  stdin.write("/provider")
  await wait(250)
  stdin.write("\r")
}, "Connect a Provider")
assert(
  openFrame.includes("Connect a Provider"),
  "wizard opens (/provider bare → startLogin → provider picker)",
  (() => {
    // Paint-order diagnostics: which clears landed, and what did the sink
    // hold after each one? Distinguishes "header never painted" from "a
    // late clear truncated the frame window the assertion looks at".
    const clears = []
    for (let i = sink.indexOf("\x1b[2J"); i >= 0; i = sink.indexOf("\x1b[2J", i + 1)) clears.push(i)
    const last = clears.length ? clears[clears.length - 1] : -1
    const win = stripAnsi(last >= 0 ? sink.slice(last) : sink)
    const full = stripAnsi(sink)
    const windows = clears
      .slice(-3)
      .map((at) => `@${at}: ${JSON.stringify(sink.slice(at, at + 160))}`)
      .join("\n")
    return (
      `--- clears=${clears.length} sinkLen=${sink.length}\n${windows}\n` +
      `--- FULL postLastClear (${win.split("\n").length} lines, hasTitle=${win.includes("Connect a Provider")}, has18=${win.includes("18. ")}, has19=${win.includes("19. ")}):\n${win}\n` +
      `--- perClearTitle: ${clears.map((at) => stripAnsi(sink.slice(at)).includes("Connect a Provider")).join(",")}\n` +
      `--- fullSink has header/subtitle/listTop: ${full.includes("Connect a Provider")} / ` +
      `${full.includes("Choose a backend")} / ${full.includes("1. ")}`
    )
  })(),
)

// ── Step 1: pick Custom endpoint (#8) → base-URL prompt, old row gone ────
const step1 = await capture(() => stdin.write("8"), "enter Base URL")
assert(
  step1.includes("enter Base URL"),
  "base-URL prompt appears after picking Custom endpoint",
  `--- frame tail ---\n${step1.slice(-500)}`,
)
assert(
  !step1.includes("Choose a provider"),
  "STEP COMPLETED → previous prompt row hidden",
  `--- frame tail ---\n${step1.slice(-500)}`,
)

// ── Step 2: Esc → cancelled notice, base-URL row gone ────────────────────
let step2 = await capture(() => stdin.write("\x1b"), "Provider connect cancelled", 20)
if (!step2.includes("Provider connect cancelled")) {
  // First Esc may have been spent clearing a draft (two-step PromptInput
  // clear) — a second one reaches cancelLogin.
  step2 = await capture(() => stdin.write("\x1b"), "Provider connect cancelled", 20)
}
assert(
  step2.includes("Provider connect cancelled"),
  "cancel notice appears on Esc",
  `--- frame tail ---\n${step2.slice(-500)}`,
)
assert(
  !step2.includes("enter Base URL"),
  "CANCELLED → base-URL prompt row hidden",
  `--- frame tail ---\n${step2.slice(-500)}`,
)

// ── Step 3: the notice's own 10s TTL fades it — transcript ends clean ────
sink = ""
await wait(11_000)
// Poke the (now idle) composer so a guaranteed full frame lands; during the
// flow any keystroke would advance the wizard, so the poke only happens
// after cancel.
stdin.write("x")
await wait(200)
stdin.write("\x7f")
await wait(500)
const finalFrame = latestFrame()
assert(
  sink.includes("\x1b[2J"),
  "a full frame landed after the wait (fade actually re-rendered)",
  `--- sink tail ---\n${JSON.stringify(sink.slice(-300))}`,
)
assert(
  !finalFrame.includes("Provider connect cancelled"),
  "outcome line faded on its 10s TTL (transcript left clean)",
  `--- frame tail ---\n${finalFrame.slice(-500)}`,
)

instance.unmount()
await wait(80)

console.log(failures === 0 ? "LOGIN_HIDE_SMOKE_OK" : `LOGIN_HIDE_SMOKE_FAIL ${failures}`)
await new Promise((r) => setTimeout(r, 100)) // flush piped stdout before exit
process.exit(failures === 0 ? 0 : 1)
