/* Devmode toggle + pentest menu E2E — "/devmode me ON/OFF toggle dalo, IF ON
 * then a menu to enable/disable pentesting tools, gate must be mentioned, and
 * it must actually work if the user has enabled them":
 *
 *   boot → /devmode (bare) = OFF→ON toggle; turning ON chains straight into
 *     the license paste (real unlock gate — the smoke mints a valid key, no
 *     bypass), and the pentest menu then opens with the current state, the
 *     GATE line (/gate on|off) and the defensive-guard mandate in the question
 *   1 → ENABLED     (config persists: developerMode.enabled=true,
 *                    toolsets.disabled no longer contains "pentest")
 *   /gate on → gate state saved (developerMode.gateEnabled — real state, the
 *     old /gate was a pure echo)
 *   /devmode status → one-line readout: mode · pentest · Gate: ON
 *   /devmode on (already ON) → menu AGAIN, now showing "Gate: ON"
 *   2 → DISABLED    (config persists: toolsets.disabled gains "pentest")
 *   /devmode off → OFF; pentest state stays as the user set it
 *   /devmode pentest while OFF → points at /devmode on
 *
 * Hermetic: TRAYAMBAK_HOME sandbox + chdir into it with a local .trayambak/
 * so saveConfig lands in the sandbox (configDir() is cwd-based, NOT
 * TRAYAMBAK_HOME-based — without the chdir this would write the real
 * ~/.trayambak or the repo's .trayambak).
 *
 * Run: node scripts/smoke-devmode-menu.mjs   (after npm run build)
 */
import { PassThrough } from "node:stream"
import { readFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import path from "node:path"
import { createServer } from "node:http"

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

// Session + config hermeticity: a fresh TRAYAMBAK_HOME for conversations, and
// a cwd-local .trayambak/ so every saveConfig() (which resolves its directory
// from process.cwd()) writes inside the sandbox.
{
  const fsMem = await import("node:fs")
  const sandbox = fsMem.mkdtempSync(path.join(tmpdir(), "trayambak-devmode-"))
  const convDir = path.join(sandbox, "skt", "8-conversations")
  fsMem.mkdirSync(convDir, { recursive: true })
  fsMem.mkdirSync(path.join(sandbox, ".trayambak"), { recursive: true })
  fsMem.writeFileSync(path.join(sandbox, "package.json"), JSON.stringify({ name: "devmode-smoke" }))
  fsMem.writeFileSync(path.join(convDir, "sessions.json"), "[]")
  process.env.TRAYAMBAK_HOME = sandbox
  process.chdir(sandbox)
}

// License gate (license.ts): pentest enable now requires a valid code, so a
// fresh sandbox would hit "Pentest tools stay DISABLED — no valid license"
// and never write config. Mint a REAL pentest-plan code with the shipped
// check key — no test bypass: this exercises the exact production verify
// path (checksum + plan + expiry), just with a legitimately minted code.
const { mintActivationKey, activationCheckKey } = await import(
  pathToFileURL(path.join(repo, "dist", "apps", "runtime", "src", "license.js")).href
)
process.env.TRAYAMBAK_LICENSE_KEY = mintActivationKey({ plan: "pentest", expDays: 3650 }, activationCheckKey())

// Server-side gate (license.ts): activation + verify ALWAYS hit a license
// server (serverActivateLicenseKey / serverVerifyLicenseKey — never fail
// open). Hermetic without a test bypass: self-host a LOCAL registry speaking
// the exact production protocol (POST /license/activate → {ok, plan, exp},
// POST /license/verify → {valid, plan, exp}) and point the app at it through
// the documented TRAYAMBAK_LICENSE_SERVER self-host override.
const mintedKey = process.env.TRAYAMBAK_LICENSE_KEY
const licExp = Math.floor(Date.now() / 1000) + 315_360_000 // +10y
const licServer = createServer((req, res) => {
  let body = ""
  req.on("data", (chunk) => {
    body += chunk
  })
  req.on("end", () => {
    let key = ""
    try {
      key = JSON.parse(body || "{}").key ?? ""
    } catch {
      key = ""
    }
    // The composer lowercases answers before they reach the resolver, so
    // compare case-insensitively (verifyLicenseKey normalizes the same way).
    const known = String(key).toUpperCase() === String(mintedKey).toUpperCase()
    const json =
      req.url === "/license/activate"
        ? known
          ? { ok: true, plan: "pentest", exp: licExp }
          : { ok: false, reason: "unknown key" }
        : req.url === "/license/verify"
          ? known
            ? { valid: true, plan: "pentest", exp: licExp }
            : { valid: false, reason: "unknown key" }
          : null
    if (json === null) {
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end("{}")
      return
    }
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(json))
  })
})
await new Promise((listenResolve) => licServer.listen(0, "127.0.0.1", listenResolve))
process.env.TRAYAMBAK_LICENSE_SERVER = `http://127.0.0.1:${licServer.address().port}`
licServer.unref() // never keeps the process alive; the OS reaps it on exit

// Hard-fail policy: any stray exception means the harness lost the plot —
// log and exit non-zero IMMEDIATELY. A logged-but-alive handler left this
// smoke hanging for 10 minutes when dist was swapped mid-run by a rebuild.
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

/** Type a slash command into the composer and submit it. */
async function sendSlash(cmd) {
  stdin.write(cmd)
  await wait(250)
  stdin.write("\r")
}

/** Answer the open question menu (1/2/…) like a user. */
async function answerMenu(choice) {
  stdin.write(choice)
  await wait(200)
  stdin.write("\r")
}

/** Read the hermetic config file (the whole point: "must actually work"). */
function readCfg() {
  return JSON.parse(readFileSync(path.join(process.cwd(), ".trayambak", "config.json"), "utf8"))
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

// Dismiss boot overlays (same two-step as smoke-app-send / smoke-login-hide).
stdin.write("\x1b")
await wait(350)
stdin.write("\x1b")
await wait(400)

// ── Step 1: bare /devmode = OFF→ON toggle → license paste → pentest menu ──
// Turning ON chains straight into the license paste (unlock gate is real,
// no test bypass); pasting the minted key must land in the pentest menu.
const step1a = await capture(() => sendSlash("/devmode"), "license key follows")
assert(
  step1a.includes("Developer mode is currently"),
  "bare /devmode opens the OFF→ON toggle",
  `--- frame tail ---\n${step1a.slice(-700)}`,
)
assert(
  step1a.includes("Turn ON") && step1a.includes("Turn OFF"),
  "toggle offers turn ON / turn OFF options",
  `--- frame tail ---\n${step1a.slice(-700)}`,
)
const step1b = await capture(() => answerMenu("1"), "Paste license key")
assert(
  step1b.includes("Paste license key"),
  "choosing ON chains straight into the license paste",
  `--- frame tail ---\n${step1b.slice(-700)}`,
)
const step1 = await capture(async () => {
  stdin.write(process.env.TRAYAMBAK_LICENSE_KEY)
  await wait(300)
  stdin.write("\r")
}, "Defensive guard for infrastructure only")
assert(
  step1.includes("Developer mode: ON"),
  "pasting the minted key unlocks devmode ON",
  `--- frame tail ---\n${step1.slice(-700)}`,
)
assert(
  step1.includes("Pentest tools: ENABLED"),
  "menu shows current pentest state (fresh config = enabled)",
  `--- frame tail ---\n${step1.slice(-700)}`,
)
assert(
  step1.includes("Gate: OFF"),
  "GATE IS MENTIONED in the devmode-on menu (OFF at boot)",
  `--- frame tail ---\n${step1.slice(-700)}`,
)
assert(
  step1.includes("Enable pentest tools") && step1.includes("Disable pentest tools"),
  "enable/disable options rendered in the menu",
  `--- frame tail ---\n${step1.slice(-700)}`,
)

// ── Step 2: pick 1 → ENABLED, persisted ──────────────────────────────────
const step2 = await capture(() => answerMenu("1"), "Pentest tools ENABLED")
assert(
  step2.includes("Pentest tools ENABLED"),
  "choosing 1 confirms pentest ENABLED",
  `--- frame tail ---\n${step2.slice(-700)}`,
)
{
  const cfg = readCfg()
  assert(cfg?.developerMode?.enabled === true, "devmode ON persisted to config", JSON.stringify(cfg?.developerMode))
  assert(
    !(cfg?.toolsets?.disabled ?? []).includes("pentest"),
    "pentest enabled persisted (toolsets.disabled has no 'pentest')",
    JSON.stringify(cfg?.toolsets),
  )
}

// ── Step 3: /gate on → real persisted gate state ─────────────────────────
const step3 = await capture(() => sendSlash("/gate on"), "Streaming gate enabled (saved)")
assert(
  step3.includes("Streaming gate enabled (saved)"),
  "/gate on saves real state (was an echo stub)",
  `--- frame tail ---\n${step3.slice(-700)}`,
)
{
  const cfg = readCfg()
  assert(
    cfg?.developerMode?.gateEnabled === true,
    "gate persisted (developerMode.gateEnabled)",
    JSON.stringify(cfg?.developerMode),
  )
}

// ── Step 4: /devmode status → mode · pentest · gate readout ──────────────
const step4 = await capture(() => sendSlash("/devmode status"), "· Gate: ON")
assert(
  step4.includes("Developer mode: ON · Pentest tools: ENABLED · Gate: ON"),
  "status line reports mode + pentest + gate together",
  `--- frame tail ---\n${step4.slice(-700)}`,
)

// ── Step 5: /devmode on (already ON) → menu again, Gate: ON mentioned ────
const step5 = await capture(() => sendSlash("/devmode on"), "Enable or disable the pentest suite?")
assert(
  step5.includes("Pentest tools: ENABLED") && step5.includes("Gate: ON"),
  "menu reopens from /devmode on with the saved gate state mentioned",
  `--- frame tail ---\n${step5.slice(-700)}`,
)

// ── Step 6: pick 2 → DISABLED, persisted ─────────────────────────────────
const step6 = await capture(() => answerMenu("2"), "Pentest tools DISABLED")
assert(
  step6.includes("Pentest tools DISABLED"),
  "choosing 2 confirms pentest DISABLED",
  `--- frame tail ---\n${step6.slice(-700)}`,
)
{
  const cfg = readCfg()
  assert(
    (cfg?.toolsets?.disabled ?? []).includes("pentest"),
    "pentest disabled persisted (toolsets.disabled contains 'pentest')",
    JSON.stringify(cfg?.toolsets),
  )
}

// ── Step 7: /devmode off → OFF, pentest state untouched ──────────────────
const step7 = await capture(() => sendSlash("/devmode off"), "Developer mode: OFF")
assert(
  step7.includes("Developer mode: OFF"),
  "/devmode off turns developer mode off",
  `--- frame tail ---\n${step7.slice(-700)}`,
)
{
  const cfg = readCfg()
  assert(cfg?.developerMode?.enabled === false, "devmode OFF persisted", JSON.stringify(cfg?.developerMode))
  assert(
    (cfg?.toolsets?.disabled ?? []).includes("pentest"),
    "pentest state survives the devmode toggle (still disabled as set)",
    JSON.stringify(cfg?.toolsets),
  )
}

// ── Step 8: /devmode pentest while OFF → points at /devmode on ───────────
const step8 = await capture(() => sendSlash("/devmode pentest"), "Developer mode is OFF")
assert(
  step8.includes("Developer mode is OFF — /devmode on"),
  "pentest menu guarded behind devmode ON with a pointer",
  `--- frame tail ---\n${step8.slice(-700)}`,
)

instance.unmount()
await wait(80)

console.log(failures === 0 ? "DEVMODE_MENU_SMOKE_OK" : `DEVMODE_MENU_SMOKE_FAIL ${failures}`)
await new Promise((r) => setTimeout(r, 100)) // flush piped stdout before exit
process.exit(failures === 0 ? 0 : 1)
