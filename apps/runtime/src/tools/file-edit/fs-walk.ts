/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as path from "path"

/** Directory names the Node walker always skips — exported so the
 *  ripgrep backend can pass the same exclusions and both backends agree. */
export const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".trayambak",
  "target",
  ".venv",
  "vendor",
])

/** Recursively walk a directory, yielding absolute file paths. */
export function walkFiles(root: string, onFile: (filePath: string, rel: string) => void, maxDepth = 20): void {
  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue
      const abs = path.join(dir, entry.name)
      const rel = path.relative(root, abs)
      if (entry.isDirectory()) {
        visit(abs, depth + 1)
      } else if (entry.isFile()) {
        onFile(abs, rel)
      }
    }
  }
  visit(root, 0)
}

/** Simple glob matcher supporting * and **. */
export function matchGlob(pattern: string, name: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
  return new RegExp(`^${regex}$`).test(name)
}
