/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"

/**
 * Where a content search runs.
 *
 * `path` on the search tools may name a FILE as well as a directory, and the
 * two need different mechanics: ripgrep wants a directory to run in plus a
 * target inside it, while the Node walker wants a directory root. Handing
 * either backend a file where it expects a directory made both fail
 * SILENTLY — the tool reported "no matches" for a file that plainly
 * contained the pattern.
 */
export interface SearchRoot {
  /** Directory the search runs in. */
  cwd: string
  /** Target handed to ripgrep: "." for a tree, the file name for a file. */
  target: string
  /** True when the root is a single file. */
  isFile: boolean
  /** Absolute path of that file (only when `isFile`). */
  file?: string
  /** Path shown to the model in messages. */
  label: string
}

/** Resolve a search root, detecting a file target. */
export function resolveSearchRoot(base: string): SearchRoot {
  let isFile = false
  try {
    isFile = fs.statSync(base).isFile()
  } catch {
    // Missing path: treat it as a tree, so the searcher reports it as such.
  }
  if (!isFile) return { cwd: base, target: ".", isFile: false, label: base }
  return {
    cwd: path.dirname(base),
    target: path.basename(base),
    isFile: true,
    file: base,
    label: base,
  }
}
