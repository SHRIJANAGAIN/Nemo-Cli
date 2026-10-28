/* Aggregator: run every scripts/smoke-*.{mjs,js} sequentially against the
 * built dist and print a PASS/FAIL summary. Sequential on purpose — parallel
 * runs raced shared dist/.smoke-tmp reads and produced false failures.
 *
 *   node scripts/run-smokes.mjs [--only <substring>]
 *
 * Each run's full output lands in .smoke-tmp/agg-<name>.log (UTF-8 file
 * methods — PowerShell *> writes UTF-16 and corrupts greps). A smoke that
 * exceeds --timeout is killed and counted as a failure (a logged-but-alive
 * uncaughtException handler once hung a run for ten minutes).
 * Exit: 0 when all pass, 1 otherwise. Run `npm run build` first.
 */
import { spawn } from "node:child_process"
import { mkdirSync, readdirSync, writeFileSync, appendFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, "..")
const outDir = path.join(repo, ".smoke-tmp")
mkdirSync(outDir, { recursive: true })

const onlyIdx = process.argv.indexOf("--only")
const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : undefined
const timeoutIdx = process.argv.indexOf("--timeout")
const timeoutMs = timeoutIdx >= 0 ? Number(process.argv[timeoutIdx + 1]) : 120_000

const scripts = readdirSync(here)
  .filter((f) => /^smoke-.*\.(mjs|js)$/.test(f))
  .filter((f) => (only ? f.includes(only) : true))
  .sort()

if (scripts.length === 0) {
  console.error(only ? `no smoke matches --only ${only}` : "no smoke scripts found")
  process.exit(1)
}

const runOne = (file) =>
  new Promise((resolve) => {
    const logPath = path.join(outDir, `agg-${file.replace(/\.(?:mjs|js)$/, "")}.log`)
    writeFileSync(logPath, "")
    const child = spawn(process.execPath, [path.join("scripts", file)], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    const keep = (chunk) => appendFileSync(logPath, chunk)
    child.stdout.on("data", keep)
    child.stderr.on("data", keep)
    child.on("close", (code) => {
      clearTimeout(timer)
      const ok = code === 0 && !timedOut
      console.log(`${ok ? "PASS" : "FAIL"}  ${file}${timedOut ? ` (killed after ${timeoutMs}ms)` : ""}`)
      resolve({ file, ok, logPath })
    })
  })

const results = []
for (const file of scripts) results.push(await runOne(file))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} smoke scripts passed`)
if (failed.length > 0) {
  for (const f of failed) {
    console.log(`\n--- tail ${path.relative(repo, f.logPath)} ---`)
    const { readFileSync } = await import("node:fs")
    const lines = readFileSync(f.logPath, "utf8").split(/\r?\n/)
    console.log(lines.slice(-25).join("\n"))
  }
  process.exit(1)
}
