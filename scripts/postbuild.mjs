/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Post-build asset staging (replaces the former inline `node -e` chain).
 *
 * 1. Copy runtime non-TS assets into dist/ (eval template, ink repl
 *    bridge, logos, prompt corpus, bundled agent personas).
 * 2. Run fix-esm-imports.js (flattens/patches the ESM ink build).
 * 3. VERIFY the result: dist entry exists and its embedded version
 *    matches package.json. A build that cannot pass this check fails,
 *    so a stale/broken dist can never leave this script green.
 *
 * Deliberately NOT copied: skt/1-errors/mistakes.json — the mistake
 * journal is user state and now lives in ~/.trayambak/ (never in the
 * package or the user's project).
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const DIST = path.join(ROOT, "dist")

function copyFile(srcRel, destRel, { required = true } = {}) {
  const src = path.join(ROOT, srcRel)
  const dest = path.join(DIST, destRel)
  if (!fs.existsSync(src)) {
    if (required) {
      console.error(`postbuild: REQUIRED asset missing: ${srcRel}`)
      process.exitCode = 1
      return false
    }
    return true
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
  return true
}

function copyTree(srcRel, destRel) {
  const src = path.join(ROOT, srcRel)
  const dest = path.join(DIST, destRel)
  fs.mkdirSync(dest, { recursive: true })
  return copyTreeAbs(src, dest)
}

/** Recursive copy that descends into subdirectories (skills/ nests every
 *  skill as <name>/SKILL.md — a flat top-level copy silently dropped the
 *  whole fleet while still reporting its count). Returns files copied. */
function copyTreeAbs(src, dest) {
  let count = 0
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true })
      count += copyTreeAbs(s, d)
    } else {
      fs.copyFileSync(s, d)
      count++
    }
  }
  return count
}

// --- 1. assets -----------------------------------------------------------
copyFile("skt/5-eval/EVALR.MD", "skt/5-eval/EVALR.MD")
copyFile("skt/5-eval/evals.json", "skt/5-eval/evals.json", { required: false })
copyFile("skt/5-eval/EVALS.MD", "skt/5-eval/EVALS.MD", { required: false })
copyFile("packages/tui/src/repl/ink-repl.mjs", "packages/tui/src/repl/ink-repl.mjs", { required: false })
copyFile("packages/tui/src/ink-app/logo_ansi.txt", "packages/tui/src/ink-app/logo_ansi.txt", { required: false })
copyFile("packages/tui/src/ink-app/logo_ansi.txt", "packages/tui/src/ink-app-esm/logo_ansi.txt", { required: false })
copyFile("apps/runtime/src/prompt/corpus.txt", "apps/runtime/src/prompt/corpus.txt", { required: false })

// Bundled specialist personas (headline feature — must ship with dist or
// they silently vanish for npm users).
if (fs.existsSync(path.join(ROOT, "assets", "agents"))) {
  const n = copyTree("assets/agents", "assets/agents")
  console.log(`postbuild: staged ${n} bundled agent personas into dist/assets/agents.`)
} else {
  console.error("postbuild: REQUIRED asset missing: assets/agents")
  process.exitCode = 1
}

// Bundled slash-command files + skills (same must-ship rule: the chooser
// menu and the skills tool go empty for npm users otherwise).
for (const dir of ["commands", "skills"]) {
  if (fs.existsSync(path.join(ROOT, dir))) {
    const n = copyTree(dir, path.join("assets", dir))
    console.log(`postbuild: staged ${n} bundled ${dir} into dist/assets/${dir}.`)
  } else {
    console.error(`postbuild: REQUIRED asset missing: ${dir}`)
    process.exitCode = 1
  }
}

if (process.exitCode) {
  console.error("postbuild: aborting before fix-esm-imports (asset staging failed).")
  process.exit(process.exitCode)
}

// --- 2. ESM fixups -------------------------------------------------------
require(path.join(ROOT, "fix-esm-imports.js"))

// --- 3. verification -----------------------------------------------------
const entry = path.join(DIST, "apps", "cli", "src", "index.js")
if (!fs.existsSync(entry)) {
  console.error("postbuild: dist/apps/cli/src/index.js missing after build!")
  process.exit(1)
}
const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version
const versionJs = path.join(DIST, "apps", "cli", "src", "version.js")
if (!fs.existsSync(versionJs)) {
  console.error("postbuild: dist/apps/cli/src/version.js missing — run `npm run sync-version`.")
  process.exit(1)
}
const distVersion = /VERSION\s*=\s*"([^"]+)"/.exec(fs.readFileSync(versionJs, "utf8"))?.[1]
if (distVersion !== pkgVersion) {
  console.error(`postbuild: dist version ${distVersion} != package.json ${pkgVersion}`)
  process.exit(1)
}
console.log(`postbuild: OK — dist verified at v${pkgVersion}.`)

// --- 4. ESM load smoke test ---------------------------------------------
// Every check above is a path/shape check, and a path check passes on a
// module that still throws the moment it is loaded — e.g. a CommonJS file
// that landed in the `type: module` flattened dir. verify-ink-esm.mjs
// actually imports the flattened entry points, so a REPL that cannot boot
// fails the build instead of shipping.
const smoke = spawnSync(process.execPath, [path.join(ROOT, "verify-ink-esm.mjs")], {
  stdio: "inherit",
  cwd: ROOT,
})
if (smoke.status !== 0) {
  console.error("postbuild: ink ESM smoke test failed — see above.")
  process.exit(1)
}
