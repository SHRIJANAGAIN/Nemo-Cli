/* Tool-result restore smoke: boots the REAL NemoApp (dist) against a
 * sandbox session whose log holds tool rows WITH persisted outcomes, and
 * asserts the resumed transcript shows results + status marks. Guards the
 * persistence fix end to end (schema → updateConversationToolResult →
 * restore mapper): before it, every resumed tool call showed args with no
 * result and no ✓/✗ fidelity.
 *
 * Seeded rows:
 *   - completed tool WITH result/isError:false  → "Called list_dir", "✓", result text
 *   - error tool WITH result/isError:true       → "✗", error text
 *   - stale "running" tool WITHOUT result       → coerced to "Called" (never "Calling")
 * Also asserts restore writes nothing back (log line count unchanged).
 *
 * Run: node scripts/smoke-persist-roundtrip.mjs
 */
import { PassThrough } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, "..")
const distEsm = pathToFileURL(path.join(repo, "dist", "packages", "tui", "src", "ink-app-esm")).href

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-persist-"))
const convDir = path.join(sandbox, "nemo", "8-conversations")
fs.mkdirSync(path.join(convDir, "sess_tools"), { recursive: true })
fs.writeFileSync(path.join(sandbox, "package.json"), JSON.stringify({ name: "persist-smoke" }))
fs.writeFileSync(
  path.join(convDir, "sessions.json"),
  JSON.stringify(
    [
      {
        sessionId: "sess_tools",
        sessionName: "Tool Session",
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
const logFile = path.join(convDir, "sess_tools", "log.jsonl")
const ts = "2026-09-25T10:00:00.000Z"
const seeded = [
  { role: "user", content: "list files", ts },
  {
    role: "assistant",
    content: JSON.stringify({ path: "." }),
    toolCallId: "c-ok",
    toolName: "list_dir",
    toolStatus: "completed",
    result: "alpha.ts\nbeta.ts",
    isError: false,
    ts,
  },
  {
    role: "assistant",
    content: JSON.stringify({ command: "npm test" }),
    toolCallId: "c-err",
    toolName: "bash",
    toolStatus: "error",
    result: "boom: explode",
    isError: true,
    ts,
  },
  {
    role: "assistant",
    content: JSON.stringify({ path: "/tmp" }),
    toolCallId: "c-stale",
    toolName: "list_dir",
    toolStatus: "running",
    ts,
  },
]
const seededLines = seeded.length
fs.writeFileSync(logFile, seeded.map((e) => JSON.stringify(e)).join("\n") + "\n")

process.env.NEMO_HOME = sandbox
// Pin Unicode glyphs (see smoke-theme-switch.mjs): status marks assert
// ✓/✗ shapes, which render as v/x under the ASCII fallback.
process.env.NEMO_GLYPHS = "unicode"

const stdin = new PassThrough()
stdin.isTTY = true
stdin.setRawMode = () => {}
stdin.ref = () => {}
stdin.unref = () => {}

const stdout = new PassThrough()
stdout.isTTY = true
stdout.columns = 150
stdout.rows = 40
let sink = ""
stdout.on("data", (chunk) => {
  sink += chunk.toString()
})

const { createSanitizedStdin } = await import(`${distEsm}/stdin-sanitizer.js`)
const sanitizedStdin = createSanitizedStdin(stdin)

const React = (await import("react")).default
const { render } = await import("ink")
const { NemoApp } = await import(`${distEsm}/index.js`)

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failures = 0
const check = (ok, label) => {
  console.log(`${ok ? "ok" : "FAIL"}: ${label}`)
  if (!ok) {
    failures += 1
    console.error("--- view tail ---")
    console.error(stripAnsi(sink).slice(-600))
  }
}

const instance = render(
  React.createElement(NemoApp, {
    config: {
      themeName: "nemo-dark", // skip ThemePicker
      baseUrl: "http://127.0.0.1:9/api", // unroutable — no network ever needed
      apiKey: "test-key",
      model: "test/model",
      cwd: process.cwd(),
    },
    modelName: "test/model",
    permissionMode: "ask",
    onExit: () => {},
  }),
  { stdin: sanitizedStdin, stdout, patchConsole: false },
)

await wait(900)
check(!stripAnsi(sink).includes("Tool Session"), "boot shows the first screen (seeded session NOT auto-listed)")

// Open the picker on demand: /sessions.
sink = ""
stdin.write("/sessions")
await wait(150)
stdin.write("\r")
await wait(500)
check(stripAnsi(sink).includes("Tool Session"), "/sessions opens the picker (seeded session listed)")

// Select it: DOWN past "+ New Chat", then Enter (resume-banner pattern).
sink = ""
stdin.write("\x1b[B")
await wait(150)
stdin.write("\r")
await wait(900)
const view = stripAnsi(sink)

check(view.includes("Called list_dir"), "completed tool restores as Called")
check(view.includes("alpha.ts"), "persisted result text restores into the transcript")
check(view.includes("✓"), "completed tool carries the status mark")
check(view.includes("✗"), "error tool carries the failure mark")
check(view.includes("boom: explode"), "error result text restores")
check(!view.includes("Calling list_dir"), "stale running row coerced (never blinks as live)")

// Restore is state-only: the log must be byte-identical afterwards.
const after = fs.readFileSync(logFile, "utf8")
check(after.split("\n").filter((l) => l.trim()).length === seededLines, "restore appended nothing to log.jsonl")

instance.unmount()
fs.rmSync(sandbox, { recursive: true, force: true })

console.log(failures === 0 ? "PERSIST_ROUNDTRIP_SMOKE_OK" : `PERSIST_ROUNDTRIP_SMOKE_FAIL ${failures}`)
process.exit(failures === 0 ? 0 : 1)
