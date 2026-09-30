/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Tarball-content gate: `npm run verify:pack`
 *
 * Asserts that ./publish/ (the npm staging dir built by
 * scripts/make-publish.mjs) contains everything it MUST ship and NOTHING
 * it must not — private journals, compiled tests, type/source maps, or
 * leaked secrets. Run after `npm run publish:build` (CI does exactly
 * that with TRAYAMBAK_SKIP_OBFUSCATION=1 for speed). Exits non-zero on
 * any violation, so CI/release can block on it.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const OUT = path.join(ROOT, "publish")
const OUT_DIST = path.join(OUT, "dist")

const errors = []
const checks = []
function ok(msg) {
  checks.push(`  ok   ${msg}`)
}
function fail(msg) {
  errors.push(msg)
  checks.push(`  FAIL ${msg}`)
}

function walk(dir, cb) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p, cb))
    else if (cb(p)) out.push(p)
  }
  return out
}

if (!fs.existsSync(OUT)) {
  console.error("verify-pack: publish/ missing — run `npm run publish:build` first.")
  process.exit(1)
}

const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))

// --- required files ------------------------------------------------------
const entry = path.join(OUT_DIST, "apps", "cli", "src", "index.js")
if (!fs.existsSync(entry)) fail("dist/apps/cli/src/index.js missing (CLI entry)")
else {
  const text = fs.readFileSync(entry, "utf8")
  text.startsWith("#!") ? ok("CLI entry has shebang") : fail("CLI entry missing #! shebang")
}

const versionJs = path.join(OUT_DIST, "apps", "cli", "src", "version.js")
if (!fs.existsSync(versionJs)) fail("dist/apps/cli/src/version.js missing")
else {
  const src = fs.readFileSync(versionJs, "utf8")
  const v = /VERSION\s*=\s*"([^"]+)"/.exec(src)?.[1]
  if (v === undefined) {
    // Obfuscated release builds inline the literal into a string array;
    // CI's non-obfuscated pack job is where the strict check bites.
    ok("embedded version inlined by obfuscator — checked via publish/package.json instead")
  } else {
    v === rootPkg.version
      ? ok(`dist version ${v} matches package.json`)
      : fail(`dist version ${v} != package.json ${rootPkg.version}`)
  }
}

for (const doc of ["LICENSE", "README.md", "package.json"]) {
  fs.existsSync(path.join(OUT, doc)) ? ok(`${doc} present`) : fail(`${doc} missing from publish/`)
}

const agentsDir = path.join(OUT_DIST, "assets", "agents")
if (!fs.existsSync(agentsDir)) fail("dist/assets/agents missing (bundled personas would silently vanish)")
else {
  const n = walk(agentsDir, () => true).length
  n >= 50 ? ok(`bundled agent personas: ${n}`) : fail(`only ${n} agent personas bundled (expected >= 50)`)
}

const pubPkg = JSON.parse(fs.readFileSync(path.join(OUT, "package.json"), "utf8"))
pubPkg.name === "@skt-ai-labs/trayambak-cli" ? ok("package name") : fail(`unexpected name ${pubPkg.name}`)
pubPkg.version === rootPkg.version
  ? ok("publish version synced")
  : fail(`publish version ${pubPkg.version} != ${rootPkg.version}`)
;(Array.isArray(pubPkg.bin?.trayambak) ? pubPkg.bin.trayambak : String(pubPkg.bin?.trayambak ?? "")).includes(
  "dist/apps/cli",
)
  ? ok("bin wiring")
  : fail("bin.trayambak does not point at dist/apps/cli/src/index.js")
pubPkg.private ? fail("publish package.json must not be private:true") : ok("not private")

// --- forbidden files -----------------------------------------------------
const forbidTests = walk(OUT_DIST, (p) => /\.test\.(js|mjs|cjs)$/.test(p) || /\.spec\.(js|mjs|cjs)$/.test(p))
forbidTests.length === 0
  ? ok("no compiled tests in tarball")
  : fail(`${forbidTests.length} compiled test files in tarball (e.g. ${path.relative(OUT, forbidTests[0])})`)

const forbidMaps = walk(OUT_DIST, (p) => p.endsWith(".d.ts") || p.endsWith(".js.map") || p.endsWith(".tsbuildinfo"))
forbidMaps.length === 0
  ? ok("no .d.ts/.js.map/.tsbuildinfo in tarball")
  : fail(`${forbidMaps.length} map/type files in tarball (e.g. ${path.relative(OUT, forbidMaps[0])})`)

const journals = walk(OUT_DIST, (p) => path.basename(p) === "mistakes.json" && p.includes(`${path.sep}skt${path.sep}`))
journals.length === 0
  ? ok("no mistake journal in tarball")
  : fail(`mistake journal leaked: ${path.relative(OUT, journals[0])}`)

const forbidTop = ["test", "tests", "__tests__"].filter((d) => fs.existsSync(path.join(OUT_DIST, d)))
forbidTop.length === 0 ? ok("no top-level test/ dirs") : fail(`top-level test dirs in tarball: ${forbidTop.join(", ")}`)

// --- secret scan ---------------------------------------------------------
const SECRET_PATTERNS = [
  [/nvapi-[A-Za-z0-9]{10,}/, "NVIDIA API key"],
  [/ghp_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/github_pat_[A-Za-z0-9_]{20,}/, "GitHub PAT"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/AIza[0-9A-Za-z_-]{30,}/, "Google API key"],
  [/sk-[A-Za-z0-9]{32,}/, "OpenAI-style secret key"],
]
const jsFiles = walk(OUT_DIST, (p) => p.endsWith(".js") || p.endsWith(".mjs"))
let secretHits = 0
for (const file of jsFiles) {
  const text = fs.readFileSync(file, "utf8")
  for (const [re, label] of SECRET_PATTERNS) {
    if (re.test(text)) {
      secretHits++
      fail(`possible ${label} in ${path.relative(OUT, file)}`)
    }
  }
}
if (secretHits === 0) ok(`secret scan clean (${jsFiles.length} files)`)

// --- report --------------------------------------------------------------
console.log(checks.join("\n"))
if (errors.length) {
  console.error(`\nverify-pack: FAILED — ${errors.length} problem(s). Do NOT publish.`)
  process.exit(1)
}
console.log(`\nverify-pack: PASS — publish/ is clean and complete (${jsFiles.length} js files staged).`)
