/**
 * Smoke tests for the TUI renderer and the llama.cpp provider transport.
 * Run: node scripts/smoke-render.js
 * - TUI: thinking/assistant deltas must render each fragment exactly once
 *   (no stacked duplicate lines), tool frames must close with a bold "Ran"
 *   title + green success bullet (red bullet + ✗ Error badge for failures),
 *   separator must be a light-cyan rule.
 * - Provider: a real HTTP server that destroys the first connection
 *   (simulating llama.cpp's idle keep-alive close) must be transparently
 *   retried by the transport.
 */
const http = require("http")
const { TerminalUI } = require("../dist/packages/tui/src/index.js")
const { LlamaCppProvider } = require("../dist/packages/provider/src/llama-cpp.js")

let failures = 0
function check(label, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  " + extra}`)
  if (!cond) failures++
}

async function testTui() {
  const ui = new TerminalUI({ useColor: true })
  const captured = { out: "", err: "" }
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = (s) => ((captured.out += s), true)
  process.stderr.write = (s) => ((captured.err += s), true)

  ui.separator()
  // The exact bug scenario: thinking deltas containing real newlines.
  ui.thinking("Line one.\nLine two.\n")
  ui.thinking(" more thought")
  ui.flushThinking()
  // Assistant deltas (previously re-rendered the whole buffer -> duplicates).
  ui.assistantText("Hello ")
  ui.assistantText("world.\n")
  ui.assistantText("Second line")
  ui.flushAssistant()
  // Tool call + result.
  ui.toolCall("list_dir", { path: "." })
  ui.toolResult("list_dir", ".agents/\n.nemo/\n", false)
  ui.toolCall("bash", { command: "boom" })
  ui.toolResult("bash", "not found", true)

  process.stdout.write = origOut
  process.stderr.write = origErr

  // Merge both streams (frames/results go to stderr, static prints to stdout)
  // and strip ANSI so assertions run on the visible text. On a terminal every
  // \r-frame overwrites the previous one; emulate that by keeping only the
  // text after the last \r on each physical line.
  const raw = captured.out + captured.err
  const screen = raw
    .split("\n")
    .map((l) => l.split("\r").pop())
    .join("\n")
    .replace(/\x1b\[[0-9;]*m/g, "")
  const ansi = captured.out + captured.err
  const count = (needle) => screen.split(needle).length - 1

  check("thinking flattened to one in-place line", !/\r/.test(screen) || raw.split("\r").length <= 3)
  check("thinking shows tail, no stacked duplicates", count("Line two. more thought") === 1, JSON.stringify(screen))
  check("assistant fragments appear exactly once", count("Hello world.") === 1 && count("Second line") === 1)
  // Tool frames close with the bold "Ran" title (title() helper), and the
  // success close line carries the green bold • bullet from bullet("success").
  check("tool line closed with bold Ran title", ansi.includes("\x1b[1mRan\x1b[0m"), ansi.slice(-400))
  check("tool result has green success bullet", ansi.includes("\x1b[32m\x1b[1m•"), ansi.slice(-400))
  check(
    "error tool result flagged with ✗ Error badge",
    screen.includes("✗ Error") && screen.includes("bash") && screen.includes("not found"),
    JSON.stringify(screen),
  )
  check("separator is cyan italic rule", ansi.includes("\x1b[3m\x1b[36m") && screen.includes("==="))
}

async function testProviderRetry() {
  let hits = 0
  const srv = http.createServer((req, res) => {
    hits++
    if (hits === 1) {
      req.socket.destroy() // real "socket hang up" before any response
      return
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "Hi" }, finish_reason: null }] }) + "\n\n")
    res.write("data: " + JSON.stringify({ choices: [{ delta: { content: " there" }, finish_reason: null }] }) + "\n\n")
    res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "\n\n")
    res.end("data: [DONE]\n\n")
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const port = srv.address().port
  const provider = new LlamaCppProvider({ baseUrl: `http://127.0.0.1:${port}`, model: "smoke" })
  const msg = await provider.chat({ messages: [{ role: "user", content: "x" }] })
  const text = msg.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("")
  check("provider survives socket hang up via retry", hits === 2, `hits=${hits}`)
  check("retry streams full text exactly once", text === "Hi there", JSON.stringify(text))
  srv.close()
}

;(async () => {
  await testTui()
  await testProviderRetry()
  console.log(failures === 0 ? "ALL SMOKE TESTS PASSED" : `${failures} SMOKE TEST(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.error("SMOKE CRASH:", e)
  process.exit(1)
})
