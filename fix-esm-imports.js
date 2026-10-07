const fs = require("fs")
const path = require("path")

// Absolute, because every containment test below compares it against
// path.resolve() output. With a relative destDir the comparison NEVER matched
// and the flatten guard silently degraded to "rewrite every ../specifier",
// which broke the surviving ink-app subdirectories.
const destDir = path.resolve(__dirname, "dist", "packages", "tui", "src", "ink-app-esm")
const srcDir = path.join(destDir, "packages", "tui", "src", "ink-app")

/**
 * Sources the flatten copied to the flat root, as absolute paths. Declared at
 * module scope because fixImports() runs AFTER the copy block closes and needs
 * to know which basenames are genuinely flattened (see flattenedNames below).
 */
const pulled = new Set()

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true })
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDirRecursive(s, d)
    else fs.copyFileSync(s, d)
  }
}

if (fs.existsSync(srcDir)) {
  copyDirRecursive(srcDir, destDir)
  // Flattened deps: files pulled in from ../ui keep their own same-dir imports
  // (theme.js -> ./skt-themes.js), which would dangle once the nested
  // packages/ tree below is deleted. Pull them in transitively.
  const uiDir = path.join(destDir, "packages", "tui", "src", "ui")
  // keymap.ts lives one level ABOVE ink-app (packages/tui/src/keymap.ts) and is
  // imported by App.tsx/PromptInput.tsx as "../keymap.js". tsconfig.ink emits
  // it under the nested packages/ tree, which line 44 deletes — so it has to be
  // pulled across explicitly or the flat ink-app-esm/keymap.js import dangles
  // and the REPL throws ERR_MODULE_NOT_FOUND on startup.
  const parentDir = path.join(destDir, "packages", "tui", "src")
  // keybindings.ts is a same-dir sibling of keymap.ts, not under ui/. Listed
  // explicitly because it is reached only through keymap.js's import, and the
  // transitive walk below resolves siblings against each file's own directory.
  const queue = [path.join(uiDir, "theme.js"), path.join(parentDir, "keymap.js")]
  while (queue.length > 0) {
    const rel = queue.shift()
    if (pulled.has(rel)) continue
    pulled.add(rel)
    const src = rel
    if (!fs.existsSync(src)) continue // verifier flags real misses below
    // Everything lands flat at the destDir root, mirroring where theme.js
    // already goes, so a sibling "./x.js" in the source resolves to the same
    // name at the root after the nested packages/ tree is deleted.
    const dest = path.join(destDir, path.basename(src))
    // Flattening by basename means two distinct sources can claim one output
    // name — and today they do: packages/tui/src/keys.ts and
    // packages/tui/src/ink-app/keys.ts are different files that both land as
    // keys.js. Last writer wins, so the REPL would silently load the wrong
    // module. Refuse instead of picking one.
    if (fs.existsSync(dest) && !fs.readFileSync(dest).equals(fs.readFileSync(src))) {
      throw new Error(
        `Flatten collision: ${src} and an already-flattened file both map to ` +
          `${dest}. Rename one source file so they do not collide.`,
      )
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    if (fs.existsSync(src + ".map")) fs.copyFileSync(src + ".map", dest + ".map")
    const content = fs.readFileSync(src, "utf8")
    // Resolve siblings against the file's OWN directory. keymap.ts and theme.ts
    // live in different dirs, so resolving everything against uiDir would send
    // keymap.js's `import "./keybindings.js"` looking in src/ui/ and silently
    // skip a file the verifier would then flag as missing.
    const siblings = []
    for (const m of content.matchAll(/from\s*(["'])\.\/([^"']+\.js)\1/g)) siblings.push(m[2])
    for (const m of content.matchAll(/require\s*\(\s*(["'])\.\/([^"']+\.js)\1\s*\)/g)) siblings.push(m[2])
    for (const s of siblings) queue.push(path.join(path.dirname(src), s))
  }
  for (const dir of ["packages", "apps", "skt", "ink-app"]) {
    const dirPath = path.join(destDir, dir)
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true })
    }
  }
}

fs.writeFileSync(path.join(destDir, "package.json"), JSON.stringify({ type: "module" }))

/**
 * Exactly the basenames the flatten copied to the flat root.
 *
 * fixImports consults this instead of "does a file with that name exist at the
 * root", because on a case-insensitive filesystem the second question has a
 * dangerous wrong answer. ink-app/Spinner.tsx and ui/spinner.ts both end up
 * named spinner.js; only the former is emitted, as `Spinner.js`. Asking
 * existsSync(root + "spinner.js") returns TRUE on Windows and Linux-through-
 * a-case-insensitive-mount, so Spinner.tsx's legitimate `../ui/spinner.js`
 * got rebased onto its own sibling and the REPL died with:
 *   SyntaxError: ./spinner.js does not provide an export named 'waveLevels'
 *
 * Membership is authoritative: `pulled` was written by the copy loop above, so
 * it cannot be fooled by a case-folded neighbour. Do NOT re-check existence
 * here to build it — the nested packages/ tree is deleted before this runs, so
 * every source path in `pulled` is already gone and an existsSync filter
 * silently empties the set (which is exactly what happened: keybindings.js
 * dropped out and WhichKey.js kept its dangling "../keybindings.js").
 */
const flattenedNames = new Set([...pulled].map((p) => path.basename(p)))

function fixImports(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      fixImports(fullPath)
    } else if (entry.name.endsWith(".js") && !entry.name.endsWith(".d.ts")) {
      let content = fs.readFileSync(fullPath, "utf8")
      content = content.replace(/from\s*(["'])(\.[^"']+)(["'])/g, (match, q1, p1, q2) => {
        // Extensionless specifiers get .js appended; a bare name stays bare.
        if (!p1.endsWith(".js")) return `from ${q1}${p1}.js${q2}`

        // ink-app's own subdirectories (UserToolResultMessage/, …) SURVIVE the
        // flatten, so their "../parent.js" hops are legitimate and must stay.
        // What does NOT survive is the nested packages/ tree the flattened
        // files came from — so a "../x.js" that escapes destDir now resolves
        // to the CommonJS build at dist/packages/tui/src/x.js, and if that CJS
        // module's named exports cjs-module-lexer cannot detect (keybindings.js
        // opens with a chained `exports.A = exports.B = void 0`), the ESM side
        // dies at launch with "does not provide an export named ...".
        //
        // Two conditions, both required:
        //   1. the specifier escapes destDir  (the nested tree is gone), and
        //   2. the target's basename is one the flatten actually copied across
        //      (see flattenedNames — existsSync is NOT safe here, a
        //      case-insensitive neighbour answers for it)
        //
        // Without (2) this rebased Spinner.tsx's `../ui/spinner.js` onto its own
        // `Spinner.js` sibling and broke the wave spinner.
        if (p1.startsWith("../")) {
          const resolved = path.resolve(path.dirname(fullPath), p1)
          const escaped = !resolved.startsWith(destDir + path.sep)
          const basename = path.basename(p1)
          if (escaped && flattenedNames.has(basename)) {
            return `from ${q1}./${basename}${q2}`
          }
        }
        return match
      })
      fs.writeFileSync(fullPath, content)
    }
  }
}

fixImports(destDir)

// Fail the build if a flattened ESM import points at a file that isn't there
// (this is how a missing sibling copy like skt-themes.js surfaces — as a
// runtime ERR_MODULE_NOT_FOUND otherwise).
function verifyImports(dir) {
  const missing = []
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith(".js") && !entry.name.endsWith(".d.ts")) {
        const content = fs.readFileSync(full, "utf8")
        const specs = []
        for (const m of content.matchAll(/from\s*(["'])(\.[^"']+)\1/g)) specs.push(m[2])
        for (const m of content.matchAll(/import\s*(["'])(\.[^"']+)\1/g)) specs.push(m[2])
        // CommonJS too. A file pulled in from outside ink-app (keymap.js) emits
        // `require("./keybindings.js")`, and a verifier that only reads `from`
        // would wave that through as if it resolved.
        for (const m of content.matchAll(/require\s*\(\s*(["'])(\.[^"']+)\1\s*\)/g)) specs.push(m[2])
        for (const spec of specs) {
          if (!spec.endsWith(".js")) continue
          const resolved = path.resolve(path.dirname(full), spec)
          if (!fs.existsSync(resolved)) {
            missing.push(`${full} -> ${spec}`)
            continue
          }
          // NOTE: an import that resolves outside this root is NOT automatically an
          // error. App.js legitimately reaches ../../../../apps/runtime/*,
          // which lands on the CommonJS build, and Node's CJS-ESM interop
          // serves those named exports fine. An earlier version of this check
          // failed the build on exactly those and had to be backed out.
          //
          // The one case that DOES break is a CJS module whose named exports
          // cjs-module-lexer cannot see — keybindings.js opens with
          // `exports.GLOBAL_SHORTCUTS = exports.DEFAULT_KEYBINDINGS = void 0`,
          // a chained assignment the lexer does not detect, so the ESM side
          // fails with "does not provide an export named ...". That is why the
          // rewrite above rebases flattened targets onto the flat root copy
          // rather than leaving them to resolve into the CJS tree. The load
          // smoke test (verify-ink-esm.mjs) is the real backstop: it imports
          // the entry points and would fail the build on any format problem.
        }
      }
    }
  }
  walk(dir)
  if (missing.length > 0) {
    throw new Error(`Flattened output has unresolved imports:\n  ${missing.join("\n  ")}`)
  }
}
verifyImports(destDir)

console.log("Fixed ESM imports and flattened output")
