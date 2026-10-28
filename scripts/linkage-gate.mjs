/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Shared module-linkage checker: every static named import in a dist tree
 * must resolve against the target file's static exports.
 *
 * Why this exists: per-file obfuscation can rewrite `exports['name']` into
 * a computed string-array lookup, which Node's static export detection
 * (cjs-module-lexer) cannot see — the importing file then dies at load
 * with "does not provide an export named". Shipped broken 0.6.0 exactly
 * this way (SessionPicker → backfillUntitledSessions). javascript-obfuscator's
 * `reservedStrings` proved nondeterministic across runs with identical
 * inputs (verified empirically: same file, same options, literal key on
 * some runs, computed on others), so options alone cannot be trusted —
 * only this gate decides.
 *
 * Used twice: inside make-publish.mjs (gate-driven fallback: failing
 * targets get re-obfuscated with `stringArray:false`, which is
 * deterministic-safe because no string table means no computed keys) and
 * in verify-pack.mjs (final assertion — fails the pack).
 *
 * Regex-level, dependency-free. ESM named imports, `export..from`
 * re-exports, destructured CJS requires vs `exports.X` / `exports['X']` /
 * defineProperty / `module.exports = {}` / ESM export declarations.
 * Bare packages, node builtins, JSON, `export *` targets, and empty
 * import lists are out of scope by design (not failures).
 */

import fs from "node:fs"
import path from "node:path"

export function splitNames(list) {
  const out = []
  for (const part of String(list).split(",")) {
    for (const w of part.split(/\s+as\s+/)) {
      const t = w.trim().replace(/^type\s+/, "")
      if (/^[A-Za-z_$][\w$]*$/.test(t) && t !== "type") out.push(t)
    }
  }
  return out
}

export function collectFileImports(code) {
  // [{names, spec}]. Default/namespace imports carry no static names;
  // dynamic import() is unchecked by design.
  const out = []
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    out.push({ names: splitNames(m[1]), spec: m[2] })
  }
  for (const m of code.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    out.push({ names: splitNames(m[1]), spec: m[2] })
  }
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.push({ names: splitNames(m[1]), spec: m[2] })
  }
  return out
}

export function collectFileExports(code) {
  const names = new Set()
  let star = false
  for (const m of code.matchAll(/exports\.([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of code.matchAll(/exports\[['"]([^'"]+)['"]\]/g)) names.add(m[1])
  for (const m of code.matchAll(/defineProperty\(\s*exports\s*,\s*['"]([^'"]+)['"]/g)) names.add(m[1])
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
    for (const n of splitNames(m[1])) names.add(n)
  }
  if (/export\s*\*/.test(code)) star = true
  // tsc compiles `export *` to a runtime __exportStar(require()) loop: no
  // static exports exist, yet every name flows through at load. Same
  // leniency as `export *` — membership unknowable statically.
  if (/__exportStar\s*\(/.test(code)) star = true
  return { names, star }
}

export function resolveRelative(distRoot, fromFile, spec) {
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

function walkJs(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walkJs(p, out)
    else if (entry.isFile() && (p.endsWith(".js") || p.endsWith(".mjs"))) out.push(p)
  }
  return out
}

/**
 * Check a whole dist tree. Returns { failures: string[], linksChecked,
 * targets: Map<targetFile, string[]> } where targets maps each failing
 * target file to the missing names (for gate-driven fallback).
 */
export function checkLinkage(outDist, distRootLabel = "dist") {
  const failures = []
  const targets = new Map()
  const exportCache = new Map()
  const targetExports = (file) => {
    if (!exportCache.has(file)) {
      exportCache.set(file, collectFileExports(fs.readFileSync(file, "utf8")))
    }
    return exportCache.get(file)
  }
  let linksChecked = 0
  for (const file of walkJs(outDist)) {
    const code = fs.readFileSync(file, "utf8")
    for (const { names, spec } of collectFileImports(code)) {
      if (names.length === 0) continue
      const target = resolveRelative(outDist, file, spec)
      if (target === "external") continue
      const rel = (f) => path.relative(outDist, f).split(path.sep).join("/")
      if (!target) {
        failures.push(`${rel(file)} imports from unresolvable "${spec}"`)
        continue
      }
      const { names: provided, star } = targetExports(target)
      if (star) continue // export *: membership unknowable statically
      for (const name of names) {
        linksChecked++
        if (!provided.has(name)) {
          failures.push(`${rel(file)} imports {${name}} from ${rel(target)} but it is not statically exported there`)
          if (!targets.has(target)) targets.set(target, [])
          if (!targets.get(target).includes(name)) targets.get(target).push(name)
        }
      }
    }
  }
  return { failures, linksChecked, targets }
}
