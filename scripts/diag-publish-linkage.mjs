/* Why did the publish linkage gate pass a tree whose ESM importer cannot get
 * its named export at runtime? Replicates verify-pack.mjs's own regexes against
 * the live publish tree and prints what the gate can and cannot see.
 *
 * Run: node scripts/diag-publish-linkage.mjs
 */
import fs from "node:fs"
import path from "node:path"

const OUT = path.resolve("publish")
const esmDir = path.join(OUT, "dist", "packages", "tui", "src", "ink-app-esm")

const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
const EXPORT_PATTERNS = [
  /exports\.([A-Za-z_$][\w$]*)/g,
  /exports\[['"]([^'"]+)['"]\]/g,
  /defineProperty\(\s*exports\s*,\s*['"]([^'"]+)['"]/g,
  /module\.exports\s*=\s*\{([^}]*)\}/g,
  /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g,
  /export\s*\{([^}]*)\}/g,
]

const log = (...a) => process.stdout.write(a.join(" ") + "\n")

// 1. every relative NAMED import inside the ESM ink-app-esm tree
let checked = 0
const edges = []
for (const f of fs.readdirSync(esmDir)) {
  if (!f.endsWith(".js")) continue
  const code = fs.readFileSync(path.join(esmDir, f), "utf8")
  for (const m of code.matchAll(IMPORT_RE)) {
    if (!m[2].startsWith(".")) continue
    const names = m[1]
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean)
    edges.push({ importer: f, spec: m[2], names })
    checked += names.length
  }
}
log(`relative named imports in the ESM tree: ${checked} name(s) over ${edges.length} edge(s)`)
const outside = edges.filter((e) => e.spec.startsWith("../"))
log(`edges leaving ink-app-esm (into the CJS build): ${outside.length}`)
for (const e of outside.slice(0, 12)) log(`  ${e.importer} -> ${e.spec} {${e.names.join(",")}}`)

// 2. what the gate's export patterns see in one of those targets
const targets = [...new Set(outside.map((e) => path.resolve(esmDir, e.spec)))]
for (const t of targets.slice(0, 6)) {
  if (!fs.existsSync(t)) {
    log(`MISSING target: ${t}`)
    continue
  }
  const code = fs.readFileSync(t, "utf8")
  const seen = new Set()
  for (const re of EXPORT_PATTERNS) {
    for (const m of code.matchAll(re)) {
      if (re.source.startsWith("module\\.exports")) {
        for (const k of m[1].matchAll(/['"]?([A-Za-z_$][\w$]*)['"]?\s*:/g)) seen.add(k[1])
      } else if (re.source.startsWith("export\\s*\\{")) {
        for (const seg of m[1].split(",")) {
          const parts = seg.trim().split(/\s+as\s+/)
          const nm = parts[parts.length - 1].trim()
          if (/^[A-Za-z_$][\w$]*$/.test(nm)) seen.add(nm)
        }
      } else {
        seen.add(m[1])
      }
    }
  }
  // Names the RUNTIME needs: Node's cjs-module-lexer can only see literal
  // `exports.X =` / `exports['X'] =` / defineProperty — a computed
  // `exports[_0x(0x1)]` is invisible to it, so an ESM named import fails.
  const lexerVisible = new Set()
  for (const m of code.matchAll(/exports\.([A-Za-z_$][\w$]*)\s*=/g)) lexerVisible.add(m[1])
  for (const m of code.matchAll(/exports\[['"]([^'"]+)['"]\]\s*=/g)) lexerVisible.add(m[1])
  for (const m of code.matchAll(/defineProperty\(\s*exports\s*,\s*['"]([^'"]+)['"]/g)) lexerVisible.add(m[1])
  const isEsm = /^\s*(?:\/\*[\s\S]*?\*\/\s*)?(?:import|export)\s/m.test(code)
  log(`${path.relative(OUT, t)}: ${isEsm ? "ESM" : "CJS"} | gate sees: ${[...seen].sort().join(",") || "(none)"}`)
  log(`   lexer-visible exports: ${[...lexerVisible].sort().join(",") || "(none)"}`)
  // the mismatch that breaks the CLI
  for (const e of outside.filter((x) => path.resolve(esmDir, x.spec) === t)) {
    for (const n of e.names) {
      if (!lexerVisible.has(n)) log(`   BROWSER EDGE: ${e.importer} needs {${n}} — NOT visible to Node's CJS lexer`)
    }
  }
}