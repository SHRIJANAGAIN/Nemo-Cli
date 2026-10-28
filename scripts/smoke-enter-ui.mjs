/* Headless E2E for Enter submission ("hey mera question to sent hua hi nahi"):
 * writes raw terminal bytes into createSanitizedStdin → Ink → PromptInput and
 * asserts onSubmit received the typed draft for every Enter byte-shape a
 * terminal can deliver: separate chars+CR, coalesced tail (y\r), whole-chunk
 * (hey\r), LF, CRLF, bracketed paste then CR, kitty CSI-u (\x1b[13u), keypad
 * kpenter (\x1b[57414u), SS3 keypad enter (\x1bOM), stray unpaired
 * paste-start. kpenter/SS3/stray-paste were the pre-fix silent-drop failures
 * (kpenter dropped, SS3 typed literal "OM", stray start swallowed Enter
 * forever) that the stdin sanitizer exists to fix.
 * This Ink has no lastFrame → onSubmit capture is the oracle; each shape
 * re-types "hey", so a stranded buffer from a previous failure shows up as a
 * doubled submitted value ("heyhey"). */
import { PassThrough } from "node:stream"
import { readFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))

// Raw terminal end: byte-for-byte what a real TTY would deliver.
const stdin = new PassThrough()
stdin.isTTY = true
stdin.setRawMode = () => {}
stdin.ref = () => {}
stdin.unref = () => {}

// Ink reads the sanitised side; tests keep writing raw bytes into `stdin`.
const { createSanitizedStdin } = await import(
  pathToFileURL(path.join(here, "..", "dist", "packages", "tui", "src", "ink-app-esm", "stdin-sanitizer.js")).href
)
const sanitizedStdin = createSanitizedStdin(stdin)

const stdout = new PassThrough()
stdout.isTTY = true
stdout.columns = 122
stdout.rows = 40
let sink = ""
stdout.on("data", (chunk) => {
  sink += chunk.toString()
})

const React = (await import("react")).default
const { render } = await import("ink")
const { PromptInput } = await import(
  pathToFileURL(path.join(here, "..", "dist", "packages", "tui", "src", "ink-app-esm", "PromptInput.js")).href
)

const submitted = []
const instance = render(
  React.createElement(PromptInput, {
    onSubmit: (value) => submitted.push(value),
    onSlashCommand: () => {},
    onChoose: () => {},
    commandList: [],
  }),
  { stdin: sanitizedStdin, stdout },
)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
const seen = () => stripAnsi(sink)

let failures = 0
function assert(cond, label) {
  if (cond) {
    console.log("ok:", label)
  } else {
    failures += 1
    console.error("FAIL:", label)
    console.error("--- stripped sink tail ---")
    console.error(seen().slice(-500))
  }
}

/** Clear composer (ctrl+l), type "hey" (optionally starting a coalesced
 *  tail chunk), send the Enter shape, and assert a clean single submit. */
async function driveShape(label, { type = "hey", enter, prelude = "" }) {
  stdin.write("\x0c") // ctrl+l clear
  await wait(80)
  const before = submitted.length
  if (prelude) stdin.write(prelude)
  await wait(prelude ? 80 : 0)
  if (type) stdin.write(type)
  await wait(80)
  stdin.write(enter)
  await wait(180)
  const got = submitted.slice(before)
  assert(got.length === 1 && got[0] === "hey", `${label} → onSubmit("hey"), got ${JSON.stringify(got)}`)
}

// ── MUST-pass shapes (standard terminals) ─────────────────────────────
await driveShape("separate chars + CR", { enter: "\r" })
await driveShape("coalesced tail (y\\r)", { prelude: "he", type: "", enter: "y\r" })
await driveShape("whole chunk (hey\\r)", { type: "", enter: "hey\r" })
await driveShape("LF only", { enter: "\n" })
await driveShape("CRLF", { enter: "\r\n" })
await driveShape("bracketed paste then CR", {
  type: "",
  enter: "\r",
  prelude: "\x1b[200~hey\x1b[201~",
})
await driveShape("kitty CSI-u \\x1b[13u", { enter: "\x1b[13u" })

// ── Exotic shapes (numpad/application-keypad/kitty kpenter) ───────────
// Rewritten to CR by createSanitizedStdin before Ink ever parses them.
await driveShape("keypad kpenter \\x1b[57414u", { enter: "\x1b[57414u" })
await driveShape("SS3 keypad \\x1bOM", { enter: "\x1bOM" })

// ── Stray unpaired paste-start: \x1b[200~ with no end marker ──────────
// Pre-fix: Ink held ALL input as pending paste forever → Enter died and
// the draft stranded. The sanitizer releases the held body as plain input
// (holdMs=150) so "hey\r" coalesces into a normal submit.
stdin.write("\x0c")
await wait(80)
{
  const before = submitted.length
  stdin.write("\x1b[200~") // stray paste-start, no end ever
  await wait(80)
  stdin.write("hey")
  await wait(80)
  stdin.write("\r")
  await wait(400) // > holdMs so the held body flushes and submits
  const got = submitted.slice(before)
  assert(got.length === 1 && got[0] === "hey", `stray unpaired paste-start still submits, got ${JSON.stringify(got)}`)
}

instance.unmount()

// Regression guard: the production launcher must actually ROUTE stdin
// through the sanitizer. It previously imported createSanitizedStdin but
// passed process.stdin directly, so every sanitizer fix only existed in
// this test while the real TUI kept losing Enter.
for (const [label, file] of [
  ["src", path.join(here, "..", "packages", "tui", "src", "repl", "ink-repl.mjs")],
  ["dist", path.join(here, "..", "dist", "packages", "tui", "src", "repl", "ink-repl.mjs")],
]) {
  const text = readFileSync(file, "utf8")
  assert(
    /stdin:\s*createSanitizedStdin\(/.test(text),
    `${label} ink-repl.mjs routes stdin through createSanitizedStdin`,
  )
}

console.log(failures === 0 ? "ENTER_SMOKE_OK" : `ENTER_SMOKE_FAIL ${failures}`)
process.exit(failures === 0 ? 0 : 1)
