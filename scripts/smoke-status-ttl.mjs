/* Status-notice TTL E2E — "✓ Model switched to … jaise saare system notices
 * 10 second baad khud gayab ho jayein": system confirmations emitted OUTSIDE
 * slash dispatch (model switch via ModelPicker, Ctrl+R's "No previous prompt
 * to edit.", queue/job notices, turn errors) used to persist forever —
 * slashTtlRef only flagged addSystemMessage while handleSlashCommand was on
 * the stack, and every UI callback (picker onSelect, PromptInput keys, panel
 * actions) runs after that stack unwound. Fix: addSystemMessage now defaults
 * to a 10s TTL for EVERY system row (explicit ttlMs wins; 0 pins rows whose
 * text must stay while input is pending — login-wizard steps via
 * addLoginRow, the question prompt, the custom-answer prompt).
 *
 * Renders the BUILT TrayambakApp on fake TTY stdin/stdout and drives it
 * like a user:
 *
 *   boot → dismiss overlays → Ctrl+R (fresh session has no prior prompt)
 *     1. "No previous prompt to edit." appears    (non-slash trigger)
 *     2. still on screen at ~4s                   (window is 10s, not instant)
 *     3. gone at ~12s                             (default TTL faded it)
 *
 * Run: node scripts/smoke-status-ttl.mjs   (after npm run build)
 */
import { PassThrough } from "node:stream"
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

// Session hermeticity (same sandbox as smoke-login-hide): a fresh
// TRAYAMBAK_HOME keeps real sessions out and starts with no prior prompt,
// so lastUserPromptRef is null and Ctrl+R takes the notice path.
{
  const fsMem = await import("node:fs")
  const sandbox = fsMem.mkdtempSync(path.join(tmpdir(), "trayambak-statusttl-"))
  const convDir = path.join(sandbox, "skt", "8-conversations")
  fsMem.mkdirSync(convDir, { recursive: true })
  fsMem.writeFileSync(path.join(sandbox, "package.json"), JSON.stringify({ name: "status-ttl-smoke" }))
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

// Dismiss boot overlays (same two-step as smoke-login-hide; with an empty
// session list the second Esc is a harmless composer clear).
stdin.write("\x1b")
await wait(350)
stdin.write("\x1b")
await wait(400)

// ── Step 1: non-slash trigger → notice appears ───────────────────────────
// Ctrl+R on a fresh session: lastUserPromptRef is null, PromptInput calls
// onRetryEdit → addSystemMessage("No previous prompt to edit.") — a UI
// callback, i.e. OUTSIDE the slash stack (the exact class as ModelPicker's
// "Model switched to …", which the bug report showed never fading).
const needle = "No previous prompt to edit"
const step1 = await capture(() => stdin.write("\x12"), needle)
assert(
  step1.includes(needle),
  "non-slash system notice appears (Ctrl+R, fresh session)",
  `--- frame tail ---\n${step1.slice(-700)}`,
)

// ── Step 2: inside the 10s window it must still be there ─────────────────
// (guards the default being an instant hide — the row must be readable)
sink = ""
await wait(4000)
stdin.write("x")
await wait(200)
stdin.write("\x7f")
await wait(500)
const midFrame = latestFrame()
assert(
  sink.includes("\x1b[2J"),
  "a full frame landed at ~4s",
  `--- sink tail ---\n${JSON.stringify(sink.slice(-300))}`,
)
assert(
  midFrame.includes(needle),
  "notice still visible inside the 10s TTL window",
  `--- frame tail ---\n${midFrame.slice(-700)}`,
)

// ── Step 3: past 10s the default TTL fades it ────────────────────────────
sink = ""
await wait(8000) // ~12s since the notice was created > 10s TTL
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
  !finalFrame.includes(needle),
  "notice faded on its 10s default TTL (transcript left clean)",
  `--- frame tail ---\n${finalFrame.slice(-700)}`,
)

instance.unmount()
await wait(80)

console.log(failures === 0 ? "STATUS_TTL_SMOKE_OK" : `STATUS_TTL_SMOKE_FAIL ${failures}`)
await new Promise((r) => setTimeout(r, 100)) // flush piped stdout before exit
process.exit(failures === 0 ? 0 : 1)
