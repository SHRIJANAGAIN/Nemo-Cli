/* ALL-tools dist E2E — "CHECK ALL HIS TOOLS WORKING OR NOT IF NOT FIX IT":
 *
 * For EVERY model-facing tool the agent ships (createDefaultTools with a
 * default config, i.e. exactly what the model can call):
 *
 *   1. Definition contract — unique name, ≤64 chars, [A-Za-z0-9_-] only
 *      (OpenAI function-name rules), non-empty description, timeoutMs ≥ 1,
 *      parameters is a JSON-schema object (type "object").
 *   2. Execute contract — empty args `{}` in an isolated sandbox must RETURN
 *      a ToolResult. A graceful isError result is a PASS (that IS argument
 *      validation working). A THROWN exception, a HANG (>8s) or a malformed
 *      result (no content array) is a FAIL — that is a broken tool.
 *   3. Positive paths — the core loop tools are driven with VALID args and
 *      must actually do their job: bash echo, write→read→edit→grep→glob,
 *      summarize, todo write→read, memory save→search→list, mode roundtrip,
 *      dream status, tool_search, read_manifest, cron create→list→delete,
 *      task create→get→update→output→list, and a checkpoint→mutate→rewind
 *      roundtrip verified against the bytes on disk.
 *
 * Isolation: chdir into a fresh sandbox with a local .nemo/ (configDir()
 * is cwd-based) and HOME/USERPROFILE/NEMO_HOME pointed at it too, so no
 * homedir()-based store (truncation, memory, auth) can be touched. Every
 * requestPermission() call is RECORDED and DENIED — a tool that asks for
 * approval on empty args never gets it.
 *
 * Run: node scripts/verify-all-tools.mjs   (after npm run build)
 * Exit: 0 = ALL_TOOLS_OK, 1 = ALL_TOOLS_FAIL (details on stderr).
 */
import { fileURLToPath, pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, "..")

// ── Isolation ───────────────────────────────────────────────────────────────
const fs = await import("node:fs")
const sandbox = fs.mkdtempSync(path.join(tmpdir(), "nemo-alltools-"))
fs.mkdirSync(path.join(sandbox, ".nemo"), { recursive: true })
fs.writeFileSync(path.join(sandbox, "package.json"), JSON.stringify({ name: "alltools-sandbox", private: true }))
process.env.NEMO_HOME = sandbox
process.env.HOME = sandbox
process.env.USERPROFILE = sandbox
process.env.TEMP = path.join(sandbox, "temp")
fs.mkdirSync(process.env.TEMP, { recursive: true })
process.chdir(sandbox)

let strayRejections = 0
process.on("uncaughtException", (error) => {
  // A crash must never read as success — a top-level throw previously let
  // this script end with exit 0 after skipping the summary.
  console.error("[uncaughtException]", error)
  process.exit(1)
})
process.on("unhandledRejection", (error) => {
  console.error("[unhandledRejection]", error)
  strayRejections += 1
})

// ── Dist imports (the shipped build, not sources) ───────────────────────────
const dist = (...parts) => pathToFileURL(path.join(repo, "dist", ...parts)).href
const { loadConfig } = await import(dist("apps", "runtime", "src", "config.js"))
const { createDefaultTools } = await import(dist("apps", "runtime", "src", "tools", "index.js"))
const { DEFAULT_PERMISSIONS } = await import(dist("packages", "protocol", "src", "permissions.js"))

const config = loadConfig()

// Permission stub: record everything, DENY everything except the one exact
// harmless echo probe used by the positive battery. No empty-args probe may
// ever act on an approval it asked for; the request itself is worth reporting.
const PERMISSION_ECHO_PROBE = "echo nemo-positive-ok"
const permissionRequests = []
const toolContext = {
  cwd: sandbox,
  config,
  permissions: DEFAULT_PERMISSIONS,
  sessionId: "verify-all-tools",
  requestPermission: async (tool, command) => {
    permissionRequests.push(String(tool))
    const name = String(tool)
    if (name === "bash") return String(command) === PERMISSION_ECHO_PROBE
    // File tools ask on every write/read. Grant only paths that resolve
    // INSIDE the sandbox — hermetic probe files, nothing else.
    const target = path.resolve(sandbox, String(command))
    const insideSandbox = target.startsWith(sandbox + path.sep)
    return insideSandbox && (name === "write_file" || name === "edit_file" || name === "read_file")
  },
}

// Mirrors Agent's construction (agent.ts): callbacks provided so delegation
// tools behave exactly as in a real session. The mode accessors share one
// closure-backed state, the way Agent.setMode/getMode do — a constant
// getter would make set_mode→get_mode look broken when it is only a stub.
let liveMode = "default"
const { tools } = createDefaultTools(
  undefined, // devMode: defaults → web fetch/search enabled
  async () => [], // onRunAgent (agent worker)
  async () => [], // onRunTeam (team/debate/parallel workers)
  async () => [], // onAskUserQuestion
  config,
  () => undefined, // onResolveSendTarget
  {
    onListFleet: async () => [],
    onGetMode: () => liveMode,
    onSetMode: (next) => {
      liveMode = next
    },
  },
)

// ── Helpers ─────────────────────────────────────────────────────────────────
const failures = []
const fail = (label, detail) => {
  failures.push({ label, detail })
  console.error(`FAIL ${label}: ${detail}`)
}

function defIssues(d) {
  const issues = []
  if (typeof d?.name !== "string" || d.name.length === 0) return ["missing definition.name"]
  if (d.name.length > 64) issues.push(`name is ${d.name.length} chars > 64`)
  if (!/^[A-Za-z0-9_-]+$/.test(d.name)) issues.push(`name has chars outside [A-Za-z0-9_-]: ${d.name}`)
  if (typeof d.description !== "string" || d.description.trim().length === 0) issues.push("empty description")
  if (typeof d.timeoutMs !== "number" || !Number.isFinite(d.timeoutMs) || d.timeoutMs < 1) {
    issues.push(`bad timeoutMs: ${String(d.timeoutMs)}`)
  }
  if (d.parameters === null || typeof d.parameters !== "object" || Array.isArray(d.parameters)) {
    issues.push("parameters is not a JSON-schema object")
  } else if (d.parameters.type !== "object") {
    issues.push(`parameters.type is ${String(d.parameters.type)} (must be "object")`)
  }
  return issues
}

const EXEC_TIMEOUT_MS = 8000
// First-spawn budget, deliberately separate from the hang budget. The Windows
// AppContainer path pays one-time initialization on its first real spawn
// (PowerShell shim start, cached helper DLL load, NTFS icacls grants whose
// own bounds are $topTimeoutMs=8000 / $grantBudgetMs=20000) measured at
// 8.0s cold, 2.9s warm, 45ms once the journal converges. Charging that
// against EXEC_TIMEOUT_MS reports a false HANG for a perfectly healthy tool,
// so the warm-up below gets its own ceiling — still finite, so a genuinely
// stuck spawn fails loudly instead of blocking the script.
const SHELL_WARMUP_TIMEOUT_MS = 60_000
function withTimeout(promise, ms, label) {
  let timer = null
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`HANG after ${ms}ms: ${label}`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Run one tool with given args. States: ok | grace | throw | hang | malformed. */
async function exec(tool, args, timeoutMs = EXEC_TIMEOUT_MS) {
  const started = Date.now()
  try {
    const result = await withTimeout(
      Promise.resolve().then(() => tool.execute("verify-1", args, undefined, undefined, toolContext)),
      timeoutMs,
      tool.definition.name,
    )
    const ms = Date.now() - started
    if (result === null || typeof result !== "object") {
      return { state: "malformed", detail: `non-object result: ${typeof result}`, ms }
    }
    if (!Array.isArray(result.content)) {
      return { state: "malformed", detail: `result.content is ${typeof result.content}`, ms }
    }
    const text = result.content
      .map((c) => (c !== null && typeof c === "object" && typeof c.text === "string" ? c.text : ""))
      .join("\n")
    return { state: result.isError === true ? "grace" : "ok", text, ms }
  } catch (error) {
    const ms = Date.now() - started
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith("HANG after")) return { state: "hang", detail: message, ms }
    return { state: "throw", detail: message, ms }
  }
}

// ── 1. Model-facing set: definitions + empty-args execute ───────────────────
console.log(`model-facing tools: ${tools.length}`)
if (tools.length < 40) fail("toolset:count", `only ${tools.length} tools model-facing (expected ≥40)`)

const seen = new Set()
const states = { ok: 0, grace: 0, throw: 0, hang: 0, malformed: 0 }

for (const tool of tools) {
  const name = tool?.definition?.name ?? "<no definition>"
  const issues = defIssues(tool?.definition)
  if (issues.length > 0) fail(`def:${name}`, issues.join("; "))
  if (seen.has(name)) fail("toolset:duplicate", name)
  seen.add(name)

  const run = await exec(tool, {})
  states[run.state] += 1
  if (run.state === "throw" || run.state === "hang" || run.state === "malformed") {
    fail(`exec:${name}`, `${run.state}: ${run.detail ?? ""}`)
  }
  const mark = run.state === "ok" ? " ok " : run.state === "grace" ? " err" : "BAD"
  console.log(`  ${mark} ${name}${run.ms >= 1000 ? ` (${run.ms}ms)` : ""}`)
}

// ── 2. Positive paths: real invocations with valid args (all sandbox-local) ─
const byName = new Map(tools.map((t) => [t.definition.name, t]))

// Warm the shell path BEFORE the positive battery times it. The first real
// spawn carries the one-time sandbox initialization cost described at
// SHELL_WARMUP_TIMEOUT_MS; running it here (with that larger ceiling) spends
// the cold cost once, so checkPos below measures the steady-state tool
// (~45ms) rather than the initializer. The SAME permission-granted command
// is used, because requestPermission denies every other bash command and a
// denied warm-up would never spawn at all. A hang here IS a failure — just
// against the initialization budget, not the hang budget.
const bashForWarmup = byName.get("bash")
if (bashForWarmup) {
  const warmStarted = Date.now()
  const warm = await exec(bashForWarmup, { command: PERMISSION_ECHO_PROBE }, SHELL_WARMUP_TIMEOUT_MS)
  console.log(`\nshell warm-up: ${warm.state} in ${Date.now() - warmStarted}ms`)
  if (warm.state === "hang") {
    fail("warm:bash", `first spawn never finished within ${SHELL_WARMUP_TIMEOUT_MS}ms`)
  }
}

console.log("\npositive paths:")

async function checkPos(label, name, args, expect = []) {
  const tool = byName.get(name)
  if (!tool) {
    fail(`pos:${label}`, "tool not model-facing")
    return ""
  }
  const run = await exec(tool, args)
  if (run.state !== "ok") {
    fail(`pos:${label}`, `${run.state}: ${String(run.detail ?? run.text ?? "").slice(0, 300)}`)
    return ""
  }
  for (const re of expect) {
    if (!re.test(run.text ?? "")) fail(`pos:${label}`, `expected ${String(re)} in: ${String(run.text).slice(0, 300)}`)
  }
  console.log(`  ok  ${label}`)
  return run.text ?? ""
}

// bash / file loop: echo → write → read → edit → grep → glob
await checkPos("bash echo", "bash", { command: PERMISSION_ECHO_PROBE }, [/nemo-positive-ok/])
const probePath = path.join(sandbox, "positive-probe.txt")
await checkPos("write_file", "write_file", { path: "positive-probe.txt", content: "nemo positive probe line\n" })
await checkPos("read_file", "read_file", { path: "positive-probe.txt" }, [/nemo positive probe line/])
await checkPos("edit_file", "edit_file", {
  path: "positive-probe.txt",
  old_string: "positive probe",
  new_string: "edited probe",
})
await checkPos("grep", "grep", { pattern: "edited probe", path: "." }, [/positive-probe\.txt/])
await checkPos("glob", "glob", { pattern: "*.txt" }, [/positive-probe\.txt/])

// summarize with inline text
await checkPos(
  "summarize",
  "summarize",
  {
    text:
      "Nemo is a deterministic coding agent that hunts bugs, verifies every tool, and summarizes " +
      "long documents into concise extractive summaries. The positive battery feeds it a deliberately " +
      "long passage so the summarizer has real work to do and returns a non-trivial excerpt instead " +
      "of an empty string or a validation error.",
  },
  [/.{20,}/],
)

// todo session list (writes sandbox-local session state)
await checkPos("todo write", "todo", { action: "write", content: "verify todo positive", priority: "high" })
await checkPos("todo read", "todo", { action: "read" }, [/verify todo positive/])

// memory store (HOME/NEMO_HOME point at the sandbox)
await checkPos("memory save", "memory", { action: "save", title: "positive probe", content: "verify memory positive fact" })
await checkPos("memory search", "memory", { action: "search", query: "positive fact" })
await checkPos("memory list", "memory", { action: "list" })

// mode roundtrip through the extra accessors Agent wires in
await checkPos("set_mode coder", "set_mode", { mode: "coder" }, [/Switched to coder/])
await checkPos("get_mode shows coder", "get_mode", {}, [/coder/])
await checkPos("set_mode default", "set_mode", { mode: "default" })

await checkPos("dream status", "dream", { action: "status" }, [/\S/])
await checkPos("tool_search", "tool_search", { query: "grep" })
await checkPos("read_manifest", "read_manifest", {}, [/alltools-sandbox/])

// cron roundtrip (in-memory job map)
const cronOut = await checkPos("cron create", "nemo__CronCreate", {
  cron: "*/5 * * * *",
  prompt: "verify cron positive",
})
const cronId = /cron_[a-z0-9]+_[a-z0-9]+/.exec(cronOut)?.[0]
if (cronId !== undefined) {
  await checkPos("cron list", "nemo__CronList", {}, [new RegExp(cronId)])
  await checkPos("cron delete", "nemo__CronDelete", { id: cronId })
} else {
  fail("pos:cron:create-id", `no cron id in: ${cronOut.slice(0, 200)}`)
}

// task roundtrip (tasks.json under sandbox HOME)
const taskOut = await checkPos("task create", "nemo__TaskCreate", {
  content: "verify task positive",
  priority: "high",
})
const taskId = /task_[a-z0-9]+_[a-z0-9]+/.exec(taskOut)?.[0]
if (taskId !== undefined) {
  await checkPos("task get", "nemo__TaskGet", { id: taskId }, [/verify task positive/])
  await checkPos("task update", "nemo__TaskUpdate", { id: taskId, status: "completed", result: "task finished ok" })
  await checkPos("task output", "nemo__TaskOutput", { id: taskId }, [/task finished ok/])
  await checkPos("task list", "nemo__TaskList", {}, [new RegExp(taskId)])
} else {
  fail("pos:task:create-id", `no task id in: ${taskOut.slice(0, 200)}`)
}

// checkpoint → mutate → rewind: the bytes on disk must come back verbatim
if (!fs.existsSync(probePath)) {
  fail("pos:checkpoint:probe", "positive-probe.txt missing — earlier file probes did not run")
} else {
  const probeBefore = fs.readFileSync(probePath, "utf8")
  const cpOut = await checkPos(
    "checkpoint",
    "nemo__Checkpoint",
    { paths: ["positive-probe.txt"], label: "verify-checkpoint" },
    [/Label: verify-checkpoint/],
  )
  const cpId = /^Checkpoint created: ([0-9a-f-]+)/mi.exec(cpOut)?.[1]
  if (cpId !== undefined) {
    fs.writeFileSync(probePath, "mutated after checkpoint\n")
    await checkPos("rewind", "nemo__Rewind", { checkpoint_id: cpId }, [/Rewind complete/])
    const restored = fs.readFileSync(probePath, "utf8")
    if (restored !== probeBefore) {
      fail("pos:rewind:bytes", `restored content differs: ${JSON.stringify(restored.slice(0, 200))}`)
    } else {
      console.log("  ok  rewind bytes verified on disk")
    }
  } else {
    fail("pos:checkpoint:id", `no checkpoint id in: ${cpOut.slice(0, 200)}`)
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log("")
console.log(
  `stats: tools=${tools.length} ok=${states.ok} graceful_err=${states.grace} ` +
    `throw=${states.throw} hang=${states.hang} malformed=${states.malformed} ` +
    `failures=${failures.length}`,
)
if (permissionRequests.length > 0) {
  console.log(
    `  permission requests (granted only for sandbox-scoped probes): ${[...new Set(permissionRequests)].join(", ")}`,
  )
}
if (strayRejections > 0) fail("runtime:stray-rejection", `${strayRejections} unhandled promise rejection(s)`)

if (failures.length === 0) {
  console.log(`ALL_TOOLS_OK tools=${tools.length}`)
  process.exit(0)
}
console.error(`ALL_TOOLS_FAIL n=${failures.length}`)
process.exit(1)
