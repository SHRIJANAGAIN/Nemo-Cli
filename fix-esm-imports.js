const fs = require("fs")
const path = require("path")

const destDir = "dist/packages/tui/src/ink-app-esm"
const srcDir = path.join(destDir, "packages", "tui", "src", "ink-app")

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
  const pulled = new Set()
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

function fixImports(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      fixImports(fullPath)
    } else if (entry.name.endsWith(".js") && !entry.name.endsWith(".d.ts")) {
      let content = fs.readFileSync(fullPath, "utf8")
      content = content.replace(/from\s*(["'])(\.[^"']+)(["'])/g, (match, q1, p1, q2) => {
        if (p1.endsWith(".js")) {
          if (p1 === "../ui/theme.js") {
            return `from ${q1}./theme.js${q2}`
          }
          return match
        }
        if (p1 === "../ui/theme") {
          return `from ${q1}./theme.js${q2}`
        }
        return `from ${q1}${p1}.js${q2}`
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
          if (!fs.existsSync(path.resolve(path.dirname(full), spec))) {
            missing.push(`${full} -> ${spec}`)
          }
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
