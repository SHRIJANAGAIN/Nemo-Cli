/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"

const IGNORED = new Set([".git", "node_modules", "dist", "build", ".trayambak", "target", ".venv", "vendor"])

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
      if (IGNORED.has(entry.name)) continue
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
