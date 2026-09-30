/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

// One-shot rebrand: Apache-2.0 headers -> Trayambak CLI Proprietary header,
// Kilo/other agent names -> SKT AI LABS, identifier + file renames.
// Skips node_modules, dist, *.bak, package-lock. Idempotent: re-running
// changes nothing (all patterns are already-absent after the first run).
import { readdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.argv[2] ?? process.cwd()
const SKIP_DIR = new Set(["node_modules", "dist", ".git"])
const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".md", ".json", ".txt"])

const NEW_HEADER = `/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */`

/** File renames applied before content edits (references use the strings). */
const FILE_RENAMES = [
  ["packages/tui/src/ui/kilo-themes.ts", "packages/tui/src/ui/skt-themes.ts"],
  ["packages/tui/src/ui/kilo-themes.test.ts", "packages/tui/src/ui/skt-themes.test.ts"],
  ["apps/cli/src/agent/websearch-kilo-exa.ts", "apps/cli/src/agent/websearch-skt-exa.ts"],
  ["scripts/convert-kilo-themes.mjs", "scripts/convert-skt-themes.mjs"],
]

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (e.isFile() && !p.endsWith(".bak") && !p.endsWith("package-lock.json")) yield p
  }
}

function ext(p) {
  const i = p.lastIndexOf(".")
  return i >= 0 ? p.slice(i) : ""
}

let headerCount = 0
let wordCount = 0
let filesChanged = new Set()

for (const [from, to] of FILE_RENAMES) {
  const a = join(ROOT, from)
  const b = join(ROOT, to)
  if (existsSync(a) && !existsSync(b)) {
    renameSync(a, b)
    console.log(`renamed ${from} -> ${to}`)
  }
}

for (const file of walk(ROOT)) {
  if (!TEXT_EXT.has(ext(file))) continue
  if (file.endsWith("rebrand-skt.mjs")) continue // keep rerun maps intact
  let s
  try {
    s = readFileSync(file, "utf8")
  } catch {
    continue
  }
  const before = s

  // 1) Apache header block -> proprietary header (first block comment only).
  const head = s.slice(0, 2000)
  const m = head.match(/\/\*[\s\S]*?Apache License[\s\S]*?\*\//)
  if (m) {
    s = s.replace(m[0], NEW_HEADER)
    headerCount++
  }
  // 1b) //-style Apache header (leading comment lines only).
  const lines = s.split("\n")
  let i = 0
  while (i < lines.length && lines[i].trim() === "") i++
  let j = i
  while (j < lines.length && lines[j].startsWith("//")) j++
  const lead = lines.slice(i, j).join("\n")
  if (j > i && /Apache License/.test(lead)) {
    const repl = NEW_HEADER.split("\n").map((l) =>
      l
        .replace(/^\/\* ?/, "// ")
        .replace(/^ \* ?/, "// ")
        .replace(/ ?\*\/$/, ""),
    )
    lines.splice(i, j - i, ...repl)
    s = lines.join("\n")
    headerCount++
  }

  // 2) Identifiers (order matters: longest first).
  const ids = [
    ["KILO_SPECS", "SKT_SPECS"],
    ["kilo-themes", "skt-themes"],
    ["websearch-kilo-exa", "websearch-skt-exa"],
    ["websearch_kilo_exa", "websearch_skt_exa"],
    ["WebsearchKiloExa", "WebsearchSktExa"],
    ["KILO_DISABLE_AUTOUPDATE", "SKT_AI_LABS_DISABLE_AUTOUPDATE"],
    ["kilo-v1", "skt-v1"],
    ["KiloCode", "SKT AI LABS"],
    ["kilocode", "SKT AI LABS"],
  ]
  for (const [a, b] of ids) {
    if (s.includes(a)) {
      s = s.split(a).join(b)
      wordCount++
    }
  }

  // 3) Bare words (word-boundary; .cline paths and data keys untouched).
  const words = [
    [/\bKILO\b/g, "SKT AI LABS"],
    [/\bKilo\b/g, "SKT AI LABS"],
  ]
  for (const [re, b] of words) {
    if (re.test(s)) {
      s = s.replace(re, b)
      wordCount++
    }
  }
  // lowercase kilo only inside comments/prose markers to avoid identifiers.
  s = s.replace(/^(\s*(\*|\/\/|#|>\s?).*?)\bkilo\b/gm, (_m, pre) => pre.replace(/\bkilo\b/g, "SKT AI LABS"))

  // 4) Reference-project mentions (comments/docs only — never .cline/ paths).
  if (!s.includes(".cline")) {
    s = s.replace(/\bCline\b/g, "SKT AI LABS").replace(/\bRoo-Code\b/g, "SKT AI LABS")
  }

  if (s !== before) {
    writeFileSync(file, s)
    filesChanged.add(file)
  }
}

console.log(`headers swapped: ${headerCount}, word/id passes: ${wordCount}, files changed: ${filesChanged.size}`)
