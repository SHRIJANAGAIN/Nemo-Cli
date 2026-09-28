/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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
  const options = {
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

  const files = walkJs(OUT_DIST, [])
  const skipObfuscation = process.env.TRAYAMBAK_SKIP_OBFUSCATION === "1" || process.argv.includes("--skip-obfuscation")
  if (skipObfuscation) {
    console.log("publish: obfuscation skipped (TRAYAMBAK_SKIP_OBFUSCATION=1 or --skip-obfuscation) — debuggable build.")
  } else {
    console.log(`publish: obfuscating ${files.length} .js files …`)
    const ts = require("typescript")
    let failed = 0
    let jsxFixed = 0
    for (const file of files) {
      try {
        let code = fs.readFileSync(file, "utf8")
        try {
          const result = JavaScriptObfuscator.obfuscate(code, options)
          fs.writeFileSync(file, result.getObfuscatedCode(), "utf8")
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
        const result = JavaScriptObfuscator.obfuscate(code, options)
        fs.writeFileSync(file, result.getObfuscatedCode(), "utf8")
      } catch (error) {
        failed++
        console.error(`publish: obfuscation FAILED for ${path.relative(OUT, file)}: ${error.message}`)
      }
    }
    if (jsxFixed > 0) console.log(`publish: ${jsxFixed} JSX file(s) downleveled via tsc first.`)
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
