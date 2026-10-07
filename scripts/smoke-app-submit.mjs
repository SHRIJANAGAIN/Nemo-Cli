/* Full-app Enter E2E — "MY RESPONSE DONT SENT TO AI".
 * smoke-enter-ui.mjs only proves PromptInput → onSubmit. This drives the REAL
 * TrayambakApp (production wiring: createSanitizedStdin → Ink → App.handleInput
 * → runAgent) and asserts the typed draft actually lands in the transcript:
 * the Welcome screen renders only while messages.length === 0, so its
 * DISAPPEARANCE after typing "HI" + Enter is the oracle that handleInput ran
 * its value branch and runAgent's addMessage fired. If onSubmit is swallowed
 * (Enter byte-shape, orphaned dialog refs, disabled composer, subagent reroute)
 * the welcome marker stays and we FAIL with the marker still present.
 * Unreachable baseUrl: runAgent adds the user message SYNCHRONOUSLY before
 * ensureAgent, and the subsequent connection error only adds a system message
 * — both replace the welcome screen, so no network is ever needed. */
import { PassThrough } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const distEsm = pathToFileURL(path.join(here, "..", "dist", "packages", "tui", "src", "ink-app-esm")).href

// Session hermeticity: a full-App boot creates real sessions in
// skt/8-conversations — without isolation, completed runs flip the next
// boot into the SessionPicker (no active session) and boot-state asserts
// flake. Same TRAYAMBAK_HOME sandbox as smoke-theme-switch; empty store =
// clean Welcome boot, and nothing touches real user sessions.
{
  const fs = await import("node:fs")
  const os = await import("node:os")
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-submit-"))
  const convDir = path.join(sandbox, "skt", "8-conversations")
  fs.mkdirSync(convDir, { recursive: true })
  fs.writeFileSync(path.join(sandbox, "package.json"), JSON.stringify({ name: "submit-smoke" }))
  fs.writeFileSync(path.join(convDir, "sessions.json"), "[]")
  process.env.TRAYAMBAK_HOME = sandbox
}

// Raw terminal end: byte-for-byte what a real TTY delivers (isTTY/setRawMode
// faked exactly like smoke-enter-ui — Ink's raw-mode path needs both).
const stdin = new PassThrough()
stdin.isTTY = true
stdin.setRawMode = () => {}
stdin.ref = () => {}
stdin.unref = () => {}

const { createSanitizedStdin } = await import(`${distEsm}/stdin-sanitizer.js`)
const sanitizedStdin = createSanitizedStdin(stdin)

// Match the user's reported environment: mid-width window (footer shows the
// narrow hint tier in their screenshot), TTY stdout.
const stdout = new PassThrough()
stdout.isTTY = true
stdout.columns = 154
stdout.rows = 40
let sink = ""
stdout.on("data", (chunk) => {
  sink += chunk.toString()
})

const React = (await import("react")).default
const { render } = await import("ink")
const { TrayambakApp } = await import(`${distEsm}/index.js`)

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")

const instance = render(
  React.createElement(TrayambakApp, {
    config: {
      themeName: "trayambak-dark", // skip ThemePicker (showThemePicker = !themeName)
      baseUrl: "http://127.0.0.1:9/api", // unroutable: fails fast, no real network
      apiKey: "test-key",
      model: "test/model",
      cwd: process.cwd(),
    },
    modelName: "test/model",
    permissionMode: "ask",
    onExit: () => {},
  }),
  { stdin: sanitizedStdin, stdout },
)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let failures = 0
function assert(cond, label) {
  if (cond) {
    console.log("ok:", label)
  } else {
    failures += 1
    console.error("FAIL:", label)
    console.error("--- stripped sink tail ---")
    console.error(stripAnsi(sink).slice(-700))
  }
}

// The welcome marker: the status block's "Tue Oct 7 15:32:04" line (weekday +
// month + day + clock) — rendered ONLY by WelcomeScreen while messages.length
// === 0. The old grep target "Welcome To Trayambak CLI" stopped existing when
// that banner line was replaced by the live clock, which made this oracle
// vacuously false at boot and vacuously TRUE after Enter (a swallowed Enter
// would have passed). Kept as an OR so restoring the banner re-validates.
const welcomeMarker =
  /(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2}/
const welcomePresent = () => {
  const text = stripAnsi(sink)
  return text.includes("Welcome To Trayambak CLI") || welcomeMarker.test(text)
}

// Boot the app and confirm the fresh-session state we're about to disturb.
await wait(600)
assert(welcomePresent(), "boot renders Welcome screen (messages.length === 0)")

// ── Shape 1: separate chars + CR (human typing on any standard terminal) ──
stdin.write("HI")
await wait(120)
// Reset the cumulative sink JUST BEFORE Enter: `welcomePresent()` only
// makes sense over frames written from now on (boot/typing frames still
// legitimately show the welcome screen, and their marker bytes can never
// leave an append-only sink — 81/88 would be contradictory otherwise).
sink = ""
stdin.write("\r")
await wait(500)
assert(!welcomePresent(), 'type "HI" + CR → welcome screen gone (message entered transcript)')
assert(stripAnsi(sink).includes("HI"), 'transcript contains "HI"')

// ── Shape 2: coalesced chunk "YO\r" (Windows console drains last char + Enter
//    in one read — the original stuck-Enter repro shape) ─────────────────────
stdin.write("\x0c") // ctrl+l clears the composer so a stranded draft shows up
await wait(80)
stdin.write("YO\r")
await wait(500)
const stripped = stripAnsi(sink)
assert(stripped.includes("YO"), 'coalesced "YO\\r" also reaches the transcript')

instance.unmount()

// Production launcher must keep the sanitizer wired (same guard as
// smoke-enter-ui — this is the file that actually runs in the user's terminal).
import { readFileSync } from "node:fs"
for (const [label, file] of [
  ["src", path.join(here, "..", "packages", "tui", "src", "repl", "ink-repl.mjs")],
  ["dist", path.join(here, "..", "dist", "packages", "tui", "src", "repl", "ink-repl.mjs")],
]) {
  const text = readFileSync(file, "utf8")
  assert(
    /stdin:\s*createSanitizedStdin\(/.test(text),
    `${label} ink-repl.mjs routes stdin through createSanitizedStdin`,
  )
  assert(/createResizeRedrawGuard\(/.test(text), `${label} ink-repl.mjs wires the resize guard`)
}

console.log(failures === 0 ? "APP_SUBMIT_SMOKE_OK" : `APP_SUBMIT_SMOKE_FAIL ${failures}`)
process.exit(failures === 0 ? 0 : 1)
