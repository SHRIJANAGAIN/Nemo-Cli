/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * check-docs-links.mjs — verify internal Markdown links resolve.
 *
 * Checks every relative link target in the top-level docs set
 * (README, CONTRIBUTING, AGENTS, SECURITY, CHANGELOG, docs/**, bin/README)
 * actually exists on disk, and every `#fragment` matches a heading slug in
 * the target file (GitHub slugger rules: lowercase, strip punctuation,
 * spaces → hyphens, duplicates get -1/-2 suffixes).
 *
 * External links (http/https/mailto) are skipped — CI has no network
 * guarantee and dead externals are not a docs-integrity failure.
 *
 * Exit 0 when clean; exit 1 with a report when any link is broken.
 * Usage: npm run check:links
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const ENTRY_FILES = ["README.md", "CONTRIBUTING.md", "AGENTS.md", "SECURITY.md", "CHANGELOG.md", "bin/README.md"]

function collectMarkdown(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectMarkdown(full, out)
    else if (entry.name.endsWith(".md")) out.push(full)
  }
  return out
}

/** GitHub heading → anchor slug. */
function slugify(heading) {
  return (
    heading
      .trim()
      .toLowerCase()
      // Drop markdown emphasis/code markers but keep their inner text.
      .replace(/[`*_~]/g, "")
      // Drop everything that isn't alphanumeric, space, or hyphen.
      .replace(/[^\w\- ]+/g, "")
      .replace(/ /g, "-")
  )
}

/** All heading slugs in a file, with GitHub's duplicate -1/-2 suffixes. */
function headingSlugs(file) {
  const seen = new Map()
  const slugs = new Set()
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.+)$/.exec(line)
    if (!m) continue
    const base = slugify(m[2])
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    slugs.add(n === 0 ? base : `${base}-${n}`)
  }
  return slugs
}

const files = [
  ...ENTRY_FILES.map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f)),
  ...collectMarkdown(path.join(ROOT, "docs")),
]

const slugCache = new Map()
const slugsFor = (file) => {
  if (!slugCache.has(file)) slugCache.set(file, headingSlugs(file))
  return slugCache.get(file)
}

const broken = []
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

for (const file of files) {
  const text = fs.readFileSync(file, "utf8")
  for (const m of text.matchAll(LINK_RE)) {
    const raw = m[1]
    if (/^(https?:|mailto:|tel:)/i.test(raw)) continue
    const line = text.slice(0, m.index).split(/\r?\n/).length

    const [target, fragment] = raw.split("#")
    let resolved
    if (target === "") {
      resolved = file // same-file anchor: page.md#heading
    } else {
      const decoded = decodeURIComponent(target)
      resolved = path.resolve(path.dirname(file), decoded.split("?")[0])
    }
    if (!fs.existsSync(resolved)) {
      broken.push(`${path.relative(ROOT, file)}:${line} → missing file: ${raw}`)
      continue
    }
    if (fragment && resolved.endsWith(".md")) {
      if (!slugsFor(resolved).has(fragment.toLowerCase())) {
        broken.push(`${path.relative(ROOT, file)}:${line} → missing anchor: ${raw}`)
      }
    }
  }
}

if (broken.length > 0) {
  console.error(`check-docs-links: ${broken.length} broken link(s):`)
  for (const b of broken) console.error(`  ${b}`)
  process.exitCode = 1
} else {
  console.log(`check-docs-links: OK — ${files.length} files, all internal links + anchors resolve.`)
}
