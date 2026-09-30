/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

// One-shot revert: Apache-2.0 headers -> Trayambak CLI Proprietary header.
// Owner-authorized (2026): the tree went Proprietary v1.0 -> Apache-2.0 in
// 0.6.0, then back to proprietary-only distribution. Idempotent: after the
// first run no Apache header remains in the leading comment, so re-running
// changes nothing. Skips node_modules, dist, *.bak, package-lock.json and
// any file whose leading comment does NOT carry an Apache License header
// (third-party content and already-converted files pass through untouched).
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.argv[2] ?? process.cwd()
const SKIP_DIR = new Set(["node_modules", "dist", ".git", "coverage"])
// Deliberately includes .py: the sweep originally only knew JS/TS extensions,
// so skt/9-session/import.py and apps/runtime/src/prompt/gen_prompt.py kept
// Apache-2.0 headers long after the rest of the tree went proprietary.
const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".pyw"])

const NEW_HEADER = `/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */`

const NEW_HEADER_SLASH = NEW_HEADER.split("\n")
  .map((l) =>
    l
      .replace(/^\/\* ?/, "// ")
      .replace(/^ \* ?/, "// ")
      .replace(/ ?\*\/$/, ""),
  )
  .join("\n")

// Same header in `#` form for Python; the closing ` */` line is dropped
// rather than turned into a stray blank line.
const NEW_HEADER_HASH = NEW_HEADER.split("\n")
  .slice(0, -1)
  .map((l, i) => (i === 0 ? l.replace(/^\/\*/, "#") : l.replace(/^\s*\*/, "#")))
  .join("\n")

// Only relicense files that claim OUR copyright. An Apache-2.0 header on a
// file we do not own is third-party code and must be left exactly as-is —
// rewriting it would misrepresent its provenance.
const OWNS_HEADER = (s) => /SKT AI LABS/.test(s)

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (statSync(p).isDirectory()) yield* walk(p)
    } else if (e.isFile()) yield p
  }
}

// Case-insensitive: skt/10-upload/retryupload.TS escaped the sweep (and eslint,
// whose config only matches `*.ts`) purely because of the uppercase extension.
function ext(p) {
  const i = p.lastIndexOf(".")
  return i >= 0 ? p.slice(i).toLowerCase() : ""
}

let headerCount = 0
let filesChanged = 0

for (const file of walk(ROOT)) {
  if (!TEXT_EXT.has(ext(file))) continue
  let s
  try {
    s = readFileSync(file, "utf8")
  } catch {
    continue
  }
  // A UTF-8 BOM makes every anchored `^...` match below fail, so a BOM'd file
  // would silently escape the sweep. Strip it for matching and put it back on
  // write so the file's existing encoding is preserved.
  const bom = s.charCodeAt(0) === 0xfeff ? "\uFEFF" : ""
  if (bom) s = s.slice(1)
  const before = s

  // 1) /* ... Apache License ... */ leading block comment (first block only,
  //    anchored at file start so mid-file mentions are never touched).
  const head = s.slice(0, 2000)
  const m = head.match(/^(#!\/[^\n]*\n)?\s*\/\*[\s\S]*?\*\//)
  if (m && /Apache License/.test(m[0]) && OWNS_HEADER(m[0])) {
    const shebang = (m[1] ?? "").replace(/\n$/, "")
    const indent = m[0].slice((m[1] ?? "").length).match(/^\s*/)[0]
    const replacement = (shebang ? shebang + "\n" : "") + indent + NEW_HEADER
    s = s.replace(m[0], replacement)
    headerCount++
  } else {
    // 2) line-comment headers: `//` for JS/TS, `#` for Python. The `#` branch
    //    is what let .py files keep Apache headers after the rest of the tree
    //    was converted — without it the sweep silently passes them by.
    const lines = s.split("\n")
    let i = 0
    if (lines[i]?.startsWith("#!")) i++
    while (i < lines.length && lines[i].trim() === "") i++
    for (const [prefix, header] of [
      ["//", NEW_HEADER_SLASH],
      ["#", NEW_HEADER_HASH],
    ]) {
      let j = i
      while (j < lines.length && lines[j].startsWith(prefix)) j++
      const lead = lines.slice(i, j).join("\n")
      if (j > i && /Apache License/.test(lead) && OWNS_HEADER(lead)) {
        lines.splice(i, j - i, header)
        s = lines.join("\n")
        headerCount++
      }
    }
  }

  if (s !== before) {
    writeFileSync(file, bom + s)
    filesChanged++
  }
}

console.log(`headers reverted: ${headerCount}, files changed: ${filesChanged}`)
