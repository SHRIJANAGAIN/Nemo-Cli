/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Build the npm-publishable package in ./publish/ (dev tree untouched):
 *   1. Copy dist/ -> publish/dist/ (drops .d.ts/.map: smaller tarball,
 *      no type maps for reversers).
 *   2. Copy LICENSE + README.md alongside.
 *   3. Ensure the CLI entry has a node shebang (npm bin shims on
 *      macOS/Linux need it; Windows works without).
 *   4. Obfuscate every publish/dist .js with module-safe options
 *      (javascript-obfuscator). The single ESM .mjs (ink-repl) is copied
 *      as-is: obfuscators rewrite import/export bindings unreliably and a
 *      broken TUI entry is worse than one readable loader file.
 *   5. Write publish/package.json (lowercase name, runtime deps only,
 *      files: ["dist"] so src/ can NEVER leak into the tarball).
 *
 *  Publish with:  npm publish ./publish   (after `npm login`)
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { checkLinkage } from "./linkage-gate.mjs"

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const DIST = path.join(ROOT, "dist")
const OUT = path.join(ROOT, "publish")
const OUT_DIST = path.join(OUT, "dist")

const CLI_ENTRY = path.join("apps", "cli", "src", "index.js")
const SHEBANG = "#!/usr/bin/env node\n"

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
}

function copyTree(src, dest, skip) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (skip(s, entry)) continue
    if (entry.isDirectory()) copyTree(s, d, skip)
    else fs.copyFileSync(s, d)
  }
}

function walkJs(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walkJs(p, out)
    else if (entry.isFile() && p.endsWith(".js")) out.push(p)
  }
  return out
}

function dirSize(dir) {
  let bytes = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) bytes += dirSize(p)
    else bytes += fs.statSync(p).size
  }
  return bytes
}

async function main() {
  if (!fs.existsSync(DIST)) {
    console.error("publish: dist/ missing — run `npm run build` first.")
    process.exitCode = 1
    return
  }
  const JavaScriptObfuscator = require("javascript-obfuscator")
  // Mute the vendor's Pro upsell banner (printed on every obfuscate()
  // call): route console output through a filter that drops their promo
  // lines but keeps real warnings/errors visible.
  const realLog = console.log.bind(console)
  const realError = console.error.bind(console)
  const isPromo = (args) =>
    args.some((a) => typeof a === "string" && (a.includes("Obfuscator Pro") || a.includes("obfuscator.io")))
  console.log = (...args) => {
    if (!isPromo(args)) realLog(...args)
  }
  console.error = (...args) => {
    if (!isPromo(args)) realError(...args)
  }

  console.log("publish: cleaning ./publish/")
  rmrf(OUT)

  console.log("publish: copying dist/ (dropping .d.ts/.map/tests/journals) …")
  copyTree(DIST, OUT_DIST, (full, entry) => {
    if (entry.isFile() && (full.endsWith(".d.ts") || full.endsWith(".js.map"))) return true
    if (entry.isFile() && (full.endsWith(".tsbuildinfo") || full.endsWith(".d.ts.map"))) return true
    // Compiled test output must never ship to users.
    if (entry.isFile() && (/\.test\.(js|mjs|cjs)$/.test(full) || /\.spec\.(js|mjs|cjs)$/.test(full))) return true
    const rel = path.relative(DIST, full)
    const top = rel.split(path.sep)[0]
    if (entry.isDirectory() && (top === "test" || top === "tests" || top === "__tests__")) return true
    // The mistake journal is private dev/user state — never publish it.
    if (entry.isFile() && path.basename(full) === "mistakes.json" && rel.startsWith(`skt${path.sep}`)) return true
    return false
  })

  for (const doc of ["LICENSE", "README.md"]) {
    const src = path.join(ROOT, doc)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, doc))
  }

  // Screenshots for the README gallery: npm renders relative image links
  // from the tarball itself, so Img/ must ship (adds ~300KB).
  const imgSrc = path.join(ROOT, "Img")
  if (fs.existsSync(imgSrc)) {
    copyTree(imgSrc, path.join(OUT, "Img"), () => false)
    console.log("publish: Img/ screenshots included.")
  }

  const entryAbs = path.join(OUT_DIST, CLI_ENTRY)
  if (!fs.existsSync(entryAbs)) {
    console.error(`publish: CLI entry missing: dist/${CLI_ENTRY}`)
    process.exitCode = 1
    return
  }
  let entryText = fs.readFileSync(entryAbs, "utf8")
  if (!entryText.startsWith("#!")) {
    fs.writeFileSync(entryAbs, SHEBANG + entryText, "utf8")
    console.log("publish: shebang added to CLI entry.")
  }

  // Module-safe preset: string-array hiding + hex ids only. Deliberately
  // OFF: controlFlowFlattening / deadCodeInjection (breaks some ESM-CJS
  // bridges), selfDefending + debugProtection (kill legit debugging and
  // trip on some terminals), disableConsoleOutput (the CLI IS console
  // output), renameGlobals (would rewrite import/export bindings),
  // transformObjectKeys (breaks dynamic property access).
  //
  // PLUS per-file linkage guards (see collectLinkage/linkageOptions): the
  // string array must never swallow a module-linkage string AND identifier
  // renaming must never rewrite an import/export binding.
  // `exports['foo']` rewritten to `exports[_0x(…)]` still runs, but Node's
  // static export detection (cjs-module-lexer) can no longer see it; and
  // `import {foo}` rewritten to `import {_0x…}` diverges per file since
  // every file gets its own hex table. Either failure kills the importing
  // file with "does not provide an export named". Shipped broken 0.6.0
  // exactly this way (SessionPicker → backfillUntitledSessions); the
  // linkage gate in verify-pack.mjs now proves every static import resolves.
  //
  // Every identifier that participates in cross-file module linkage, so the
  // string array leaves its spellings alone. Runs on pre-obfuscation dist
  // code with regexes (fast, no parse): import/export bindings, CJS
  // `exports.X` / `defineProperty(exports, "X")` / `module.exports = {...}`
  // keys, and destructured `require()` names. Over-reserving (e.g. a local
  // alias, a `type` modifier) only costs a few hidden strings — never
  // correctness. Under-reserving ships another 0.6.0, so when in doubt the
  // patterns below err wide.
  const collectLinkageNames = (code) => {
    const names = new Set()
    const pushList = (list) => {
      for (const part of String(list).split(",")) {
        for (const w of part.split(/\s+as\s+/)) {
          const m = /^[A-Za-z_$][\w$]*/.exec(w.trim())
          if (m && m[0] !== "type") names.add(m[0])
        }
      }
    }
    for (const m of code.matchAll(/import\s*\{([^}]*)\}/g)) pushList(m[1])
    for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) pushList(m[1])
    for (const m of code.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g))
      names.add(m[1])
    for (const m of code.matchAll(/exports\.([A-Za-z_$][\w$]*)/g)) names.add(m[1])
    for (const m of code.matchAll(/defineProperty\(\s*exports\s*,\s*['"]([^'"]+)['"]/g)) names.add(m[1])
    for (const m of code.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) {
      for (const key of m[1].matchAll(/['"]?([A-Za-z_$][\w$]*)['"]?\s*:/g)) names.add(key[1])
      for (const sh of m[1].split(",")) {
        const t = sh.trim()
        if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t)
      }
    }
    for (const m of code.matchAll(/[{,]\s*([^}=]*?)\}\s*=\s*require\(/g)) pushList(m[1])
    return [...names]
  }
  const escLinkage = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // Both identifier renaming AND string-array encoding break linkage, so
  // every file gets both guards from the same name set.
  const linkageOptions = (code) => {
    const names = collectLinkageNames(code)
    return { reservedNames: names, reservedStrings: names.map((n) => `^${escLinkage(n)}$`) }
  }

  const baseOptions = {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    debugProtection: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: "hexadecimal",
    renameGlobals: false,
    rotateStringArray: true,
    selfDefending: false,
    shuffleStringArray: true,
    splitStrings: false,
    stringArray: true,
    stringArrayThreshold: 0.75,
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
  }

  // Build-time mirror of the verify-pack linkage gate (same static export
  // language — keep the two collectors in sync by hand).
  //
  // Why this exists: reservedStrings does NOT protect `exports.X` member
  // keys (proven: `exports[_0x(0xcd)]=loadSessions` despite `^loadSessions$`
  // in reservedStrings — plain string literals are honored, export keys are
  // still swallowed into the string array). So every file is verified after
  // obfuscation and retried with the string array off when an export
  // spelling went missing. Deterministic per file; obfuscation elsewhere
  // (compact, identifier renaming with reservedNames) is untouched.
  const providedExports = (src) => {
    const names = new Set()
    for (const m of src.matchAll(/exports\.([A-Za-z_$][\w$]*)/g)) names.add(m[1])
    for (const m of src.matchAll(/exports\[['"]([^'"]+)['"]\]/g)) names.add(m[1])
    for (const m of src.matchAll(/defineProperty\(\s*exports\s*,\s*['"]([^'"]+)['"]/g)) names.add(m[1])
    for (const m of src.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) {
      for (const key of m[1].matchAll(/['"]?([A-Za-z_$][\w$]*)['"]?\s*:/g)) names.add(key[1])
      for (const sh of m[1].split(",")) {
        const t = sh.trim()
        if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t)
      }
    }
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g))
      names.add(m[1])
    for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(",")) {
        for (const w of part.split(/\s+as\s+/)) {
          const t = w.trim().replace(/^type\s+/, "")
          if (/^[A-Za-z_$][\w$]*$/.test(t) && t !== "type") names.add(t)
        }
      }
    }
    // tsc's module marker is not cross-file linkage — the gate never checks
    // it either (nothing ever imports __esModule by name).
    names.delete("__esModule")
    return names
  }
  const verifyExports = (src, obf) => {
    if (/export\s*\*/.test(src)) return true // gate leniency: star membership unknowable
    const expected = providedExports(src)
    if (expected.size === 0) return true
    const got = providedExports(obf)
    return [...expected].every((n) => got.has(n))
  }

  // Bundled content (personas, slash-command bodies, skill helpers) ships
  // as-is, never obfuscated: skill `scripts/*.js` run via `node` from the
  // skill's own directory (renaming their internals buys nothing), and at
  // least one ships with non-standard syntax the obfuscator cannot even
  // parse. The single ESM .mjs (ink-repl) already gets the same treatment.
  const allJs = walkJs(OUT_DIST, [])
  const files = allJs.filter((f) => !f.includes(`${path.sep}assets${path.sep}`))
  if (files.length !== allJs.length) {
    console.log(`publish: ${allJs.length - files.length} bundled-asset .js file(s) ship as-is (no obfuscation).`)
  }
  const skipObfuscation = process.env.TRAYAMBAK_SKIP_OBFUSCATION === "1" || process.argv.includes("--skip-obfuscation")
  if (skipObfuscation) {
    console.log("publish: obfuscation skipped (TRAYAMBAK_SKIP_OBFUSCATION=1 or --skip-obfuscation) — debuggable build.")
  } else {
    console.log(`publish: obfuscating ${files.length} .js files …`)
    const ts = require("typescript")
    let failed = 0
    let jsxFixed = 0
    let degraded = 0
    let barrelSkipped = 0
    // Write first-attempt output only if the file's static export spellings
    // survived; otherwise retry that file with the string array off (see
    // providedExports/verifyExports above). Single obfuscation in the
    // common case — the fallback re-runs only broken files.
    const writeVerified = (file, finalCode, options, firstObfuscated) => {
      if (verifyExports(finalCode, firstObfuscated)) {
        fs.writeFileSync(file, firstObfuscated, "utf8")
        return
      }
      degraded++
      const rel = path.relative(OUT, file)
      const retry = JavaScriptObfuscator.obfuscate(finalCode, {
        ...options,
        stringArray: false,
      }).getObfuscatedCode()
      if (!verifyExports(finalCode, retry)) throw new Error(`linkage still broken without stringArray: ${rel}`)
      fs.writeFileSync(file, retry, "utf8")
      console.log(`publish: stringArray off for ${rel} (linkage-safe fallback).`)
    }
    for (const file of files) {
      try {
        let code = fs.readFileSync(file, "utf8")
        // Pure CJS star-barrels (only __exportStar re-export calls, zero
        // static exports of their own) ship as-is: obfuscation would rename
        // the helper and encode the require specs, leaving the linkage gate
        // nothing static to resolve transitively. Barrels hold no logic.
        if (providedExports(code).size === 0 && /__exportStar\s*\(\s*require\(/.test(code)) {
          barrelSkipped++
          continue
        }
        const options = { ...baseOptions, ...linkageOptions(code) }
        try {
          const result = JavaScriptObfuscator.obfuscate(code, options)
          const obfuscated = result.getObfuscatedCode()
          writeVerified(file, code, options, obfuscated)
          if (file.endsWith("skt/9-session/session.js") || file.endsWith("skt\\9-session\\session.js")) {
            console.log(
              `publish: DEBUG session.js output keeps backfill=${obfuscated.includes("'backfillUntitledSessions'")}`,
            )
          }
          continue
        } catch (first) {
          // Ink .js keeps JSX (tsconfig.ink uses jsx:preserve): the
          // obfuscator cannot parse `<Box …>`. Downlevel it with the
          // already-installed TypeScript (transform-only, no type info —
          // tsc already typechecked), then obfuscate the plain JS.
          if (!/<[A-Z][A-Za-z]*[\s>]/.test(code)) throw first
          const out = ts.transpileModule(code, {
            compilerOptions: {
              jsx: ts.JsxEmit.ReactJSX,
              target: ts.ScriptTarget.ES2020,
              module: ts.ModuleKind.CommonJS,
            },
            fileName: path.basename(file),
          })
          code = out.outputText
          jsxFixed++
        }
        // Recompute on the (possibly downleveled) code: the tsc pass
        // rewrites module syntax but keeps linkage spellings.
        const retryOptions = { ...baseOptions, ...linkageOptions(code) }
        const result = JavaScriptObfuscator.obfuscate(code, retryOptions)
        writeVerified(file, code, retryOptions, result.getObfuscatedCode())
      } catch (error) {
        failed++
        console.error(`publish: obfuscation FAILED for ${path.relative(OUT, file)}: ${error.message}`)
      }
    }
    if (jsxFixed > 0) console.log(`publish: ${jsxFixed} JSX file(s) downleveled via tsc first.`)
    if (degraded > 0) console.log(`publish: ${degraded} file(s) use stringArray:false (linkage-safe fallback).`)
    if (barrelSkipped > 0) console.log(`publish: ${barrelSkipped} star-barrel file(s) shipped as-is (transitive gate).`)
    if (failed > 0) {
      console.error(`publish: ${failed} file(s) failed — aborting, ./publish/ left for inspection.`)
      process.exitCode = 1
      return
    }
  } // end if (!skipObfuscation)

  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
  const publishPkg = {
    name: "@skt-ai-labs/trayambak-cli",
    version: rootPkg.version,
    description: "Trayambak — local-first terminal coding agent by SKT AI LABS PRIVATE LIMITED.",
    license: rootPkg.license,
    author: rootPkg.author,
    type: rootPkg.type,
    engines: rootPkg.engines,
    bin: {
      trayambak: "dist/apps/cli/src/index.js",
      skt: "dist/apps/cli/src/index.js",
    },
    files: ["dist", "Img"],
    dependencies: rootPkg.dependencies,
  }
  fs.writeFileSync(path.join(OUT, "package.json"), JSON.stringify(publishPkg, null, 2) + "\n", "utf8")

  const mb = (n) => (n / 1048576).toFixed(1) + "MB"
  const mode = skipObfuscation ? "copied unobfuscated" : "obfuscated"
  console.log(
    `publish: dist ${mb(dirSize(DIST))} -> publish/dist ${mb(dirSize(OUT_DIST))} (${files.length} files ${mode}, 1 .mjs copied as-is).`,
  )
  console.log("publish: ready. Next: `npm login` then `npm publish ./publish`.")
}

main().catch((error) => {
  console.error(`publish: fatal: ${error.stack || error.message}`)
  process.exitCode = 1
})
