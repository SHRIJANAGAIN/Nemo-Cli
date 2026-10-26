/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Stale-dist guard used by the bin/*.cmd dev shims (and CI).
 *
 * Exit 0 : dist exists AND its embedded version matches package.json.
 * Exit 1 : dist missing or stale (shim triggers a rebuild).
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const entry = path.join(ROOT, "dist", "apps", "cli", "src", "index.js")
const versionJs = path.join(ROOT, "dist", "apps", "cli", "src", "version.js")

if (!fs.existsSync(entry) || !fs.existsSync(versionJs)) {
  console.error("check-dist: dist missing or incomplete.")
  process.exit(1)
}

const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version
const distVersion = /VERSION\s*=\s*"([^"]+)"/.exec(fs.readFileSync(versionJs, "utf8"))?.[1]

if (distVersion !== pkgVersion) {
  console.error(`check-dist: stale dist (dist=${distVersion ?? "?"} package.json=${pkgVersion}).`)
  process.exit(1)
}
process.exit(0)
