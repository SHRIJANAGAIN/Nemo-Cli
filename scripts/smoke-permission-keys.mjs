/* Permission-key matrix smoke: drives the REAL PermissionOverlay (dist)
 * through every decision key and asserts the right resolver fires —
 * including the Esc-with-draft regression (Esc used to be swallowed while
 * the composer held text, leaving Deny unreachable with no affordance).
 *
 * y/a/s/n/x/Enter/↑↓ need no agent run: the overlay is rendered directly
 * with two queued requests. Full turn-driven approval (model → tool call
 * → prompt) needs network and stays out of scope by design.
 *
 * Run: node scripts/smoke-permission-keys.mjs
 */
import { PassThrough } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, "..")
const distEsm = pathToFileURL(path.join(repo, "dist", "packages", "tui", "src", "ink-app-esm")).href

const stdin = new PassThrough()
stdin.isTTY = true
stdin.setRawMode = () => {}
stdin.ref = () => {}
stdin.unref = () => {}

const stdout = new PassThrough()
stdout.isTTY = true
stdout.columns = 120
stdout.rows = 30
let sink = ""
stdout.on("data", (chunk) => {
  sink += chunk.toString()
})

const React = (await import("react")).default
const { render } = await import("ink")
const { PermissionOverlay } = await import(`${distEsm}/PermissionOverlay.js`)

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const reqs = [
  { id: "r1", tool: "bash", reason: "run tests", args: { command: "npm test" } },
  { id: "r2", tool: "write", reason: "patch file", args: { path: "a.ts" } },
]

let failures = 0
const check = (ok, label) => {
  console.log(`${ok ? "ok" : "FAIL"}: ${label}`)
  if (!ok) {
    failures += 1
    console.error("--- view tail ---")
    console.error(stripAnsi(sink).slice(-500))
  }
}

const runPhase = async (props, keys) => {
  const calls = []
  const handlers = {
    onApprove: (id) => calls.push(["approve", id]),
    onDeny: (id) => calls.push(["deny", id]),
    onApproveSession: (id) => calls.push(["session", id]),
    onApproveAlways: (id) => calls.push(["always", id]),
    onDenyAlways: (id) => calls.push(["deny-always", id]),
  }
  const instance = render(React.createElement(PermissionOverlay, { ...props, ...handlers }), {
    stdin,
    stdout,
    patchConsole: false,
  })
  await wait(350)
  for (const k of keys) {
    sink = ""
    stdin.write(k)
    await wait(200)
  }
  await wait(150)
  instance.unmount()
  await wait(100)
  return calls
}

// ── 1. y approves the selected (first) request ──────────────────────────
let calls = await runPhase({ permissionMode: "ask", pendingRequests: reqs, composerHasText: false }, ["y"])
check(calls.length === 1 && calls[0][0] === "approve" && calls[0][1] === "r1", "y approves r1")

// ── 2. ↓ moves, n denies the second ─────────────────────────────────────
calls = await runPhase({ permissionMode: "ask", pendingRequests: reqs, composerHasText: false }, ["\x1b[B", "n"])
check(calls.length === 1 && calls[0][0] === "deny" && calls[0][1] === "r2", "down-arrow + n denies r2")

// ── 3. a / s / x fire their own resolvers ───────────────────────────────
calls = await runPhase({ permissionMode: "ask", pendingRequests: [reqs[0]], composerHasText: false }, ["a"])
check(calls.length === 1 && calls[0][0] === "always", "a = approve always")
calls = await runPhase({ permissionMode: "ask", pendingRequests: [reqs[0]], composerHasText: false }, ["s"])
check(calls.length === 1 && calls[0][0] === "session", "s = approve session")
calls = await runPhase({ permissionMode: "ask", pendingRequests: [reqs[0]], composerHasText: false }, ["x"])
check(calls.length === 1 && calls[0][0] === "deny-always", "x = deny always")

// ── 4. Enter = allow once ───────────────────────────────────────────────
calls = await runPhase({ permissionMode: "ask", pendingRequests: [reqs[1]], composerHasText: false }, ["\r"])
check(calls.length === 1 && calls[0][0] === "approve" && calls[0][1] === "r2", "Enter approves once")

// ── 5. Esc denies even with a composer draft (the regression) ──────────
calls = await runPhase({ permissionMode: "ask", pendingRequests: [reqs[0]], composerHasText: true }, ["\x1b"])
check(calls.length === 1 && calls[0][0] === "deny", "Esc denies with composerHasText=true")

// ── 6. …but y is typing, not a decision, while the draft stands ────────
calls = await runPhase({ permissionMode: "ask", pendingRequests: [reqs[0]], composerHasText: true }, ["y"])
check(calls.length === 0, "y with a draft fires nothing")

console.log(failures === 0 ? "PERMISSION_KEYS_SMOKE_OK" : `PERMISSION_KEYS_SMOKE_FAIL ${failures}`)
process.exit(failures === 0 ? 0 : 1)
