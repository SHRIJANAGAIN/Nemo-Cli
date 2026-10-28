/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Trial identity: was this rollout finished, and by this configuration?
 *
 * Completion is recorded explicitly by the code that observed the run
 * return; the presence of output is not enough. The marker also
 * fingerprints the harness that produced the rollout, so a rollout from a
 * different configuration is never reused.
 *
 * Adapted from Harness² (Copyright 2026 Google LLC, Apache-2.0) — see
 * NOTICE.md in this directory.
 */

import { createHash } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { walk } from "./tree.js"

/** The completion marker's file name. */
export const MARK = ".adapt_complete"

/** The marker schema version. A bump invalidates every earlier marker. */
export const MARK_VERSION = 1

/** Byproducts that are not part of the harness and must not change its identity. */
function ignored(file: string): boolean {
  const base = path.basename(file)
  return base === MARK || base === ".DS_Store" || base.endsWith(".pyc")
}

/**
 * A stable digest of the harness tree that produced a rollout.
 *
 * `null` means a base rollout on the inherited harness and digests to the
 * shared value `base`, so every base run in a task shares one identity.
 */
export function fingerprint(harnessDir: string | null | undefined): string {
  if (harnessDir === null || harnessDir === undefined) return "base"
  let stat: fs.Stats
  try {
    stat = fs.statSync(harnessDir)
  } catch {
    return "absent"
  }
  if (!stat.isDirectory()) return "absent"
  const hash = createHash("sha1")
  for (const file of walk(harnessDir)) {
    if (ignored(file)) continue
    const rel = path.relative(harnessDir, file).replace(/\\/g, "/")
    hash.update(rel)
    hash.update("\0")
    try {
      hash.update(fs.readFileSync(file))
    } catch {
      hash.update("<unreadable>")
    }
    hash.update("\0")
  }
  return hash.digest("hex").slice(0, 16)
}

/** The marker payload written next to a finished rollout. */
export interface RunMark {
  version: number
  runId: string
  at: number
  harness: string
  [key: string]: string | number | boolean | null
}

/**
 * Record that `runId` finished.
 *
 * Call only after the runner returned normally: a marker is a claim about
 * what happened, and writing one after a throw would make a crashed run
 * look reusable.
 */
export function markComplete(
  where: string,
  input: {
    runId: string
    harnessDir?: string | null
    extra?: Record<string, string | number | boolean | null>
  },
): string {
  fs.mkdirSync(where, { recursive: true })
  const payload: RunMark = {
    version: MARK_VERSION,
    runId: input.runId,
    at: Date.now() / 1000,
    harness: fingerprint(input.harnessDir),
    ...(input.extra ?? {}),
  }
  const tmp = path.join(where, `${MARK}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(payload, Object.keys(payload).sort(), 2), "utf8")
  const final = path.join(where, MARK)
  fs.renameSync(tmp, final)
  return final
}

/** Read a marker, or `null` when it is absent or unreadable. */
export function readMark(where: string): RunMark | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(where, MARK), "utf8"))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
    return parsed as RunMark
  } catch {
    return null
  }
}

/**
 * Whether the artifacts at `where` may be reused: a current marker naming
 * the same harness, unless `matchHarness` is off.
 */
export function isComplete(
  where: string,
  options: { harnessDir?: string | null; matchHarness?: boolean } = {},
): boolean {
  const mark = readMark(where)
  if (!mark || mark.version !== MARK_VERSION) return false
  if (options.matchHarness === false) return true
  return mark.harness === fingerprint(options.harnessDir)
}

/** A sentence explaining why `where` is or is not reusable. */
export function whyNot(where: string, options: { harnessDir?: string | null } = {}): string {
  const mark = readMark(where)
  if (!mark) return `no ${MARK} -- never finished, or finished before completion was recorded`
  if (mark.version !== MARK_VERSION) return `marker version ${mark.version} != ${MARK_VERSION}`
  const want = fingerprint(options.harnessDir)
  if (want !== mark.harness) {
    return `harness fingerprint ${mark.harness} != ${want} -- produced by a different configuration`
  }
  return "reusable"
}

/** The default scratch root for a run's work directory. */
export function scratchDir(prefix = "nemo-harness-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}
