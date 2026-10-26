/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Tarball-content gate: `npm run verify:pack`
 *
 * Asserts that ./publish/ (the npm staging dir built by
 * scripts/make-publish.mjs) contains everything it MUST ship and NOTHING
 * it must not — private journals, compiled tests, type/source maps, or
 * leaked secrets. Run after `npm run publish:build` (CI does exactly
 * that with NEMO_SKIP_OBFUSCATION=1 for speed). Exits non-zero on
 * any violation, so CI/release can block on it.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

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

// Bundled slash-command files + skills (same must-ship rule: the chooser
// menu and the skills tool go empty for npm users otherwise).
const commandsDir = path.join(OUT_DIST, "assets", "commands")
if (!fs.existsSync(commandsDir)) fail("dist/assets/commands missing (chooser would go empty for npm users)")
else {
  const n = walk(commandsDir, () => true).length
  n >= 50 ? ok(`bundled slash commands: ${n}`) : fail(`only ${n} slash commands bundled (expected >= 50)`)
}

const skillsDir = path.join(OUT_DIST, "assets", "skills")
if (!fs.existsSync(skillsDir)) fail("dist/assets/skills missing (skills tool would go empty for npm users)")
else {
  const n = walk(skillsDir, (p) => path.basename(p) === "SKILL.md").length
  n >= 50 ? ok(`bundled skills: ${n}`) : fail(`only ${n} SKILL.md files bundled (expected >= 50)`)
}

const pubPkg = JSON.parse(fs.readFileSync(path.join(OUT, "package.json"), "utf8"))
pubPkg.name === "@shrijan/nemo-cli" ? ok("package name") : fail(`unexpected name ${pubPkg.name}`)
pubPkg.version === rootPkg.version
  ? ok("publish version synced")
  : fail(`publish version ${pubPkg.version} != ${rootPkg.version}`)
;(Array.isArray(pubPkg.bin?.nemo) ? pubPkg.bin.nemo : String(pubPkg.bin?.nemo ?? "")).includes(
  "dist/apps/cli",
)
  ? ok("bin wiring")
  : fail("bin.nemo does not point at dist/apps/cli/src/index.js")
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

const journals = walk(OUT_DIST, (p) => path.basename(p) === "mistakes.json" && p.includes(`${path.sep}nemo${path.sep}`))
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

// --- module linkage gate ---------------------------------------------------
// Every static named import in publish/dist must resolve against the
// target file's static exports — the same linkage contract the obfuscator
// is told to preserve (reservedStrings in make-publish.mjs). Regex-level,
// dependency-free: ESM named imports, `export..from` re-exports, and
// destructured CJS requires against `exports.X` / `exports['X']` /
// defineProperty / `module.exports = {}` / ESM export declarations.
// Shipped broken 0.6.0 exactly here (SessionPicker importing
// backfillUntitledSessions from an obfuscated session.js whose export had
// become a computed lookup) — this gate fails the pack instead.
function splitNames(list) {
  const out = []
  for (const part of String(list).split(",")) {
    for (const w of part.split(/\s+as\s+/)) {
      const t = w.trim().replace(/^type\s+/, "")
      if (/^[A-Za-z_$][\w$]*$/.test(t) && t !== "type") out.push(t)
    }
  }
  return out
}

// Alias-correct variants: `import {Orig as Local}` needs Orig from the
// target (Local exists only in the importer — demanding it from the target
// is a false failure, e.g. App.js `setThemeByName as applyNemoTheme`
// vs theme.js). Conversely `export {A as B}` (no from) provides B, not A.
function splitNeedNames(list) {
  const out = []
  for (const part of String(list).split(",")) {
    const t = part
      .split(/\s+as\s+/)[0]
      .trim()
      .replace(/^type\s+/, "")
    if (/^[A-Za-z_$][\w$]*$/.test(t) && t !== "type") out.push(t)
  }
  return out
}

function splitProvideNames(list) {
  const out = []
  for (const part of String(list).split(",")) {
    const segs = part.split(/\s+as\s+/)
    const t = segs[segs.length - 1].trim().replace(/^type\s+/, "")
    if (/^[A-Za-z_$][\w$]*$/.test(t) && t !== "type") out.push(t)
  }
  return out
}

function collectFileImports(code) {
  // Returns [{names, spec}]. Default/namespace imports carry no static
  // names to check; dynamic import() is unchecked by design.
  const out = []
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    out.push({ names: splitNeedNames(m[1]), spec: m[2] })
  }
  for (const m of code.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    out.push({ names: splitNeedNames(m[1]), spec: m[2] })
  }
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.push({ names: splitNames(m[1]), spec: m[2] })
  }
  return out
}

function collectFileExports(code) {
  // ASSIGNMENTS ONLY, deliberately. An ESM `import {X}` of a CJS file is
  // served by Node's cjs-module-lexer, which synthesises a named export only
  // from a top-level assignment it can read literally (`exports.X =`,
  // `exports['X'] =`, `module.exports.X =`, `Object.defineProperty(exports,'X')`)
  // or an ESM export declaration. A read (`function f(a = exports['X'])`) or a
  // computed key (`exports[_0x(0x1)] =`) is invisible to it — counting those
  // as "provided" let this gate pass a tree that then died at startup with
  // "does not provide an export named 'GLOBAL_SHORTCUTS'".
  const names = new Set()
  let star = false
  for (const m of code.matchAll(/exports\.([A-Za-z_$][\w$]*)\s*=[^=]/g)) names.add(m[1])
  for (const m of code.matchAll(/exports\[['"]([^'"]+)['"]\]\s*=[^=]/g)) names.add(m[1])
  for (const m of code.matchAll(/module\.exports\.([A-Za-z_$][\w$]*)\s*=[^=]/g)) names.add(m[1])
  // `Object['defineProperty'](…)` is the obfuscated spelling of the same call.
  for (const m of code.matchAll(/defineProperty['"]?\]?\s*\(\s*exports\s*,\s*['"]([^'"]+)['"]/g))
    names.add(m[1])
  for (const m of code.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) {
    for (const key of m[1].matchAll(/['"]?([A-Za-z_$][\w$]*)['"]?\s*:/g)) names.add(key[1])
    for (const sh of m[1].split(",")) {
      const t = sh.trim()
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t)
    }
  }
  for (const m of code.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g))
    names.add(m[1])
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const n of splitProvideNames(m[1])) names.add(n)
  }
  if (/export\s*\*/.test(code)) star = true
  return { names, star }
}

function resolveRelative(fromFile, spec) {
  // Bare packages (react, ink), node builtins (node:fs, fs), and JSON are
  // someone else's contract — the gate only polices OUR relative files.
  if (!spec.startsWith(".")) return "external"
  if (spec.endsWith(".json")) return "external"
  const base = path.resolve(path.dirname(fromFile), spec)
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`]
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c
    } catch {
      /* try next */
    }
  }
  for (const c of [".js", ".mjs", ".cjs"].map((e) => path.join(base, `index${e}`))) {
    try {
      if (fs.statSync(c).isFile()) return c
    } catch {
      /* try next */
    }
  }
  return null
}

{
  const allJs = walk(OUT_DIST, (p) => p.endsWith(".js") || p.endsWith(".mjs"))
  const exportCache = new Map()
  const textCache = new Map()
  const readText = (file) => {
    if (!textCache.has(file)) textCache.set(file, fs.readFileSync(file, "utf8"))
    return textCache.get(file)
  }
  const literalExports = (file) => {
    if (!exportCache.has(file)) {
      exportCache.set(file, collectFileExports(readText(file)))
    }
    return exportCache.get(file)
  }
  // tsc CommonJS barrels re-export via __exportStar(require(spec)) calls —
  // no static spellings of their own. Resolve transitively (cycle-guarded);
  // star never re-exports "default".
  const targetExports = (file, seen = new Set()) => {
    const { names, star } = literalExports(file)
    const out = new Set(names)
    if (!star) {
      for (const m of readText(file).matchAll(/__exportStar\s*\(\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const t = resolveRelative(file, m[1])
        if (!t || t === "external" || seen.has(t)) continue
        seen.add(t)
        for (const n of targetExports(t, seen).names) if (n !== "default") out.add(n)
      }
    }
    return { names: out, star }
  }
  let linksChecked = 0
  for (const file of allJs) {
    const code = readText(file)
    for (const { names, spec } of collectFileImports(code)) {
      if (names.length === 0) continue
      const target = resolveRelative(file, spec)
      if (target === "external") continue
      if (!target) {
        fail(`${path.relative(OUT, file)} imports from unresolvable "${spec}"`)
        continue
      }
      const { names: provided, star } = targetExports(target, new Set([target]))
      if (star) continue // export *: membership unknowable statically
      for (const name of names) {
        linksChecked++
        if (!provided.has(name)) {
          fail(
            `${path.relative(OUT, file)} imports {${name}} from ${path.relative(OUT, target)} but it is not statically exported there`,
          )
        }
      }
    }
  }
  errors.length === 0 && linksChecked > 0
    ? ok(`module linkage: ${linksChecked} static imports resolve`)
    : errors.length === 0
      ? fail("module linkage: no static imports found — gate is blind, investigate")
      : undefined
}

// --- 11. PUBLISHED entry points actually load --------------------------------
// Static linkage above CANNOT catch the flattened-module bug, because the
// broken specifier and the legitimate CJS-interop ones are indistinguishable
// without running them. They only diverge once the code is obfuscated:
// cjs-module-lexer stops recognising the named exports of a CJS module whose
// body has been rewritten, so an ESM import of a flattened module's CJS twin
// dies at launch with
//
//   SyntaxError: The requested module '../keybindings.js' does not provide an
//   export named 'GLOBAL_SHORTCUTS'
//
// A plain `npm run build` stays green through all of that, which is why this
// shipped. Only the PUBLISHED tree shows it, so only the published tree is
// loaded here. App.js is included deliberately: it transitively pulls in the
// whole ink-app surface, so one import exercises the real graph.
async function checkPublishedModulesLoad() {
  const dir = path.join(OUT, "dist", "packages", "tui", "src", "ink-app-esm")
  if (!fs.existsSync(dir)) return undefined
  const targets = ["WhichKey.js", "Spinner.js", "keybindings.js", "keymap.js", "App.js"]
  const failures = []
  for (const file of targets) {
    const full = path.join(dir, file)
    if (!fs.existsSync(full)) {
      failures.push(`${file}: missing from publish/`)
      continue
    }
    try {
      await import(pathToFileURL(full).href)
    } catch (err) {
      failures.push(`${file}: ${String(err.message).split("\n")[0]}`)
    }
  }
  if (failures.length === 0) ok(`published modules load: ${targets.length} obfuscated entry points imported`)
  else fail(`published modules load:\n    ${failures.join("\n    ")}`)
}

await checkPublishedModulesLoad()

// --- report --------------------------------------------------------------
console.log(checks.join("\n"))
if (errors.length) {
  console.error(`\nverify-pack: FAILED — ${errors.length} problem(s). Do NOT publish.`)
  process.exit(1)
}
console.log(`\nverify-pack: PASS — publish/ is clean and complete (${jsFiles.length} js files staged).`)
