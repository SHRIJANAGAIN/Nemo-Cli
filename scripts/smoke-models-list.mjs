/* Full-app E2E for "sarre models fetch krke display kre, fallback 5 remove":
 * the model picker used to show ONLY the catalog's 5-row NVIDIA static list
 * because (a) postRaw truncated every response to 500 bytes so the real
 * /v1/models JSON never parsed ("empty" → fallback) and (b) resolveModels
 * padded failures with staticModels that looked like the full catalog.
 *
 * Drives the REAL NemoApp: local server serves 12 distinctive ids on
 * GET /v1/models, config points provider nvidia at it, then /models runs the
 * production path (loadConfig → fetchModelsDetailed → resolveModels →
 * ModelPicker). Asserts the picker shows all 12 live ids, NEVER a static
 * fallback id or the "5 models" count, and that the live list lands in the
 * sandbox modelCache (live → cached chain).
 * Hermetic: chdir into a temp sandbox so configDir() resolves there — the
 * user's real ~/.nemo config is neither read nor written. */
import { PassThrough } from "node:stream"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const distEsm = pathToFileURL(path.join(here, "..", "dist", "packages", "tui", "src", "ink-app-esm")).href

// Env hermeticity: no ambient overrides may leak into loadConfig().
for (const env of [
  "NEMO_BASE_URL",
  "NEMO_API_KEY",
  "NEMO_PROVIDER",
  "NEMO_THEME",
  "NEMO_MODEL",
]) {
  delete process.env[env]
}

// Local /v1/models server: 12 distinctive ids, ignores auth headers.
const MODELS = Array.from({ length: 12 }, (_, i) => `smoke/model-${i + 1}`)
const server = http.createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ object: "list", data: MODELS.map((id) => ({ id })) }))
    return
  }
  res.writeHead(404).end("{}")
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const port = server.address().port

// Sandbox: chdir BEFORE the app boots so configDir() = <sandbox>/.nemo.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-models-"))
process.chdir(sandbox)
const config = {
  themeName: "nemo-dark", // skip ThemePicker
  provider: "nvidia",
  baseUrl: `http://127.0.0.1:${port}`,
  apiKey: "test-key",
  model: "test/model",
  cwd: sandbox,
}
fs.mkdirSync(path.join(sandbox, ".nemo"), { recursive: true })
fs.writeFileSync(path.join(sandbox, ".nemo", "config.json"), JSON.stringify(config, null, 2))
const convDir = path.join(sandbox, "nemo", "8-conversations")
fs.mkdirSync(convDir, { recursive: true })
fs.writeFileSync(path.join(convDir, "sessions.json"), "[]")
fs.writeFileSync(path.join(sandbox, "package.json"), JSON.stringify({ name: "models-smoke" }))
process.env.NEMO_HOME = sandbox

// Raw terminal end (faked TTY exactly like the other full-app smokes).
const stdin = new PassThrough()
stdin.isTTY = true
stdin.setRawMode = () => {}
stdin.ref = () => {}
stdin.unref = () => {}

const { createSanitizedStdin } = await import(`${distEsm}/stdin-sanitizer.js`)
const sanitizedStdin = createSanitizedStdin(stdin)

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
const { NemoApp } = await import(`${distEsm}/index.js`)

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")

const instance = render(
  React.createElement(NemoApp, {
    config,
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
    console.error(stripAnsi(sink).slice(-900))
  }
}

await wait(700)
assert(stripAnsi(sink).includes("Welcome To Nemo CLI"), "boot renders Welcome screen")

// Run the production /models path against the local server.
sink = ""
stdin.write("/models")
await wait(120)
stdin.write("\r")
await wait(900)
const frame = stripAnsi(sink)

assert(frame.includes("12 models"), 'picker count line shows "12 models" (live list, not 5)')
assert(frame.includes("smoke/model-12"), "all live ids rendered (smoke/model-12 in window)")
assert(!frame.includes("nemotron-3-super-120b-a12b"), "static fallback id never rendered")
assert(!frame.includes("mixtral-8x7b-instruct"), "static fallback id (mixtral) never rendered")
assert(!frame.includes("5 models"), 'no "5 models" count anywhere')

// Live list must persist to the sandbox modelCache (live → cached chain).
const saved = JSON.parse(fs.readFileSync(path.join(sandbox, ".nemo", "config.json"), "utf8"))
const cache = saved.modelCache?.nvidia ?? []
assert(cache.length === 12, `modelCache.nvidia persisted 12 live ids (got ${cache.length})`)

instance.unmount()
server.closeAllConnections?.()
server.close()
console.log(failures === 0 ? "MODELS_SMOKE_OK" : `MODELS_SMOKE_FAIL ${failures}`)
await new Promise((r) => setTimeout(r, 100)) // flush piped stdout before exit
process.exit(failures === 0 ? 0 : 1)
